"""What a meeting was (kind, client, people), a note name the vault accepts, the whole meeting as a file for
Claude or Codex, and Watson finding meetings by words and dates: only normal ones, only the asker's."""

import asyncio
import json
import time
from contextlib import contextmanager

import pytest

from agora_core import brain_tools, fiscal, meeting_notes, meeting_tools, meetings, routes_meetings
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache
from tests.test_meeting_notes import H, OWNER, client  # noqa: F401 - the fixture

OTHER = "c" * 64


def test_el_titulo_de_la_nota_vale_para_el_vault():
    assert meeting_notes.note_title("2026-11-16 Reunión del 16/11/2026 10:30") == "2026-11-16 Reunión del 16-11-2026 10.30"
    assert meeting_notes.note_title(".oculta​ #1 [a]?") == "oculta -1 -a--"
    assert meeting_notes.note_title("::") == "Reunión"
    assert len(meeting_notes.note_title("á" * 300).encode()) <= 240


def test_tipo_cliente_y_personas_se_validan():
    assert meetings.classify("training", "  Acme   SL ", ["Ana", "ana", " Luis ", ""]) == ("training", "Acme SL", [{"name": "Ana", "email": None}, {"name": "Luis", "email": None}])
    with pytest.raises(meetings.MeetingError):
        meetings.classify("fiesta", None, [])
    with pytest.raises(meetings.MeetingError):
        meetings.classify("call", None, "Ana")
    title = meetings.default_title("training", "Acme")
    assert title.startswith("Formación con Acme · ") and ":" not in title and "/" not in title


def _done(client, meeting_id):  # noqa: F811
    for _ in range(100):
        detail = client.get(f"/meetings/{meeting_id}", headers=H).json()
        if detail["work"] in ("done", "failed"):
            return detail
        time.sleep(0.05)
    raise AssertionError("no terminó")


def test_clasificada_resumida_y_exportada(client, monkeypatch, tmp_path):  # noqa: F811
    heard = {}
    monkeypatch.setattr(meeting_notes, "summarize", lambda level, title, text, engines, chosen: heard.update(title=title) or (
        {"summary": "Se explicó el panel.", "topics": [{"topic": "Panel", "detail": "Cómo se crean usuarios."}], "decisions": [], "tasks": []}, "claude", None))
    assert client.post("/meetings", json={"mic_type": "audio/webm", "client": "Acme"}, headers=H).status_code == 422, "sin Central no hay clientes"
    database = connect(client.data / DB_NAME)
    database.execute("INSERT INTO setting (key, value) VALUES ('central.snapshot', ?)", (json.dumps({"clients": [{"name": "Acme"}, {"name": "Beta"}]}),))
    database.commit()
    database.close()
    started = client.post("/meetings", json={"mic_type": "audio/webm", "kind": "training", "client": "acme", "people": ["Ana"]}, headers=H).json()
    assert started["client"] == "Acme", "con el nombre de Central"
    assert client.patch(f"/meetings/{started['id']}", json={"client": "Inventado"}, headers=H).status_code == 422
    assert started["title"].startswith("Formación con Acme") and started["kind"] == "training" and started["people"] == [{"name": "Ana", "email": None}]
    assert client.post("/meetings", json={"mic_type": "audio/webm", "kind": "fiesta"}, headers=H).status_code == 422
    changed = client.patch(f"/meetings/{started['id']}", json={"people": ["Ana", {"name": "Luis Pérez", "email": "Luis@Beta.com"}, {"name": "Mal", "email": "no-es-correo"}], "title": "Formación: el panel"}, headers=H).json()
    assert changed["people"] == [{"name": "Ana", "email": None}, {"name": "Luis Pérez", "email": "luis@beta.com"}, {"name": "Mal", "email": None}]
    assert changed["client"] == "Acme" and changed["title"] == "Formación: el panel"
    assert client.patch(f"/meetings/{started['id']}", json={"kind": "x"}, headers={**H, "x-agora-owner": OTHER}).status_code == 404, "solo el dueño"
    client.post(f"/meetings/{started['id']}/mic", content=b"m" * 2000, headers=H)
    assert client.post(f"/meetings/{started['id']}/export", headers=H).status_code == 422, "sin transcripción no hay archivo"
    client.post(f"/meetings/{started['id']}/stop", headers=H)
    client.post(f"/meetings/{started['id']}/process", json={}, headers=H)
    detail = _done(client, started["id"])
    assert "Tipo: Formación" in heard["title"] and "Cliente: Acme" in heard["title"] and "Participantes: Ana, Luis Pérez, Mal" in heard["title"]
    content, title = detail["draft"]["content"], detail["draft"]["title"]
    assert ":" not in title and title.endswith("Acme · Formación. el panel"), "el cliente y el título de la reunión"
    assert "# Acme · Formación: el panel" in content
    assert "tipo: formación" in content and 'cliente: "Acme"' in content and '  - "Luis Pérez <luis@beta.com>"' in content
    assert "## Resumen extendido" in content and "### Panel" in content and "Cómo se crean usuarios." in content
    folder = tmp_path / "Descargas"
    folder.mkdir()
    shown = []
    monkeypatch.setattr(routes_meetings, "downloads", lambda: folder)
    monkeypatch.setattr(fiscal, "open_in_finder", lambda root, name, reveal: shown.append((root, name, reveal)))
    first = client.post(f"/meetings/{started['id']}/export", headers=H).json()
    second = client.post(f"/meetings/{started['id']}/export", headers=H).json()
    assert first["name"] == f"{title}.md" and second["name"] == f"{title} (2).md", "nunca sobrescribe"
    assert (folder / first["name"]).read_text() == content.replace(" <luis@beta.com>", "") and shown[0] == (folder, first["name"], True)


@pytest.fixture
def database(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    rows = [(OWNER, "Kickoff web", "normal", "2026-11-10T09:00:00Z", "meeting", "Acme", ["Ana"], "Hablamos del presupuesto de la web."),
            (OWNER, "Formación panel", "normal", "2026-11-14T16:00:00Z", "training", None, [], "Cómo se crean los usuarios."),
            (OWNER, "Privada", "local_only", "2026-11-14T10:00:00Z", "meeting", "Acme", [], "El presupuesto secreto."),
            (OTHER, "De otro", "normal", "2026-11-14T10:00:00Z", "meeting", "Acme", [], "El presupuesto ajeno.")]
    for owner, title, level, start, kind, who, people, said in rows:
        connection.execute(
            """INSERT INTO meeting (owner, title, confidentiality, status, started_at, ended_at, mic_type, kind, client, people, transcript, summary)
               VALUES (?, ?, ?, 'recorded', ?, ?, 'webm', ?, ?, ?, ?, ?)""",
            (owner, title, level, start, start.replace(":00:00Z", ":30:00Z"), kind, who, json.dumps(people),
             json.dumps([{"start": 1.0, "end": 2.0, "text": said, "speaker": "Los demás"}]),
             json.dumps({"summary": f"Resumen de {title}", "topics": [], "decisions": [], "tasks": []})))
    connection.commit()
    yield connection
    connection.close()


def test_watson_encuentra_solo_las_reuniones_normales_del_usuario(database):
    found = meeting_tools.find(database, OWNER, "presupuesto")
    assert [m["titulo"] for m in found] == ["Kickoff web"], "ni la privada ni la de otro"
    assert found[0]["cliente"] == "Acme" and found[0]["frases"] == ["Los demás: Hablamos del presupuesto de la web."] and found[0]["minutos"] == 30
    assert [m["titulo"] for m in meeting_tools.find(database, OWNER)] == ["Formación panel", "Kickoff web"], "sin filtro, las últimas"
    assert [m["titulo"] for m in meeting_tools.find(database, OWNER, since="2026-11-14", until="2026-11-14")] == ["Formación panel"]
    assert [m["titulo"] for m in meeting_tools.find(database, OWNER, kind="formación")] == ["Formación panel"]
    assert [m["titulo"] for m in meeting_tools.find(database, OWNER, "acme")] == ["Kickoff web"]
    assert meeting_tools.find(database, OWNER, since="2026-12-01", until="2026-12-01") == []
    assert [m["titulo"] for m in meeting_tools.latest(database, OWNER)] == ["Formación panel", "Kickoff web"], "las últimas, sin la privada ni la de otro"
    with pytest.raises(ValueError):
        meeting_tools.find(database, OWNER, since="la semana pasada")
    private = database.execute("SELECT id FROM meeting WHERE title = 'Privada'").fetchone()["id"]
    assert meeting_tools.read(database, OWNER, private) is None


def test_watson_lee_una_reunion_solo_tras_encontrarla(database, tmp_path):
    @contextmanager
    def opened():
        connection = connect(tmp_path / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()
    box = brain_tools.Toolbox(opened, None, VectorCache())
    box.owner = OWNER
    kickoff = database.execute("SELECT id FROM meeting WHERE title = 'Kickoff web'").fetchone()["id"]
    refused = json.loads(asyncio.run(box.call("leer_reunion", {"id": kickoff})))
    assert "error" in refused
    found = json.loads(asyncio.run(box.call("consultar_reuniones", {"consulta": "web"})))
    assert [m["id"] for m in found["reuniones"]] == [kickoff]
    read = json.loads(asyncio.run(box.call("leer_reunion", {"id": kickoff})))
    assert "[00:01] Los demás: Hablamos del presupuesto" in read["texto"] and read["partes"] == 1
    assert [e["tool"] for e in box.history] == ["meetings", "meeting"]
    empty = json.loads(asyncio.run(box.call("consultar_reuniones", {"desde": "2026-12-01", "hasta": "2026-12-01"})))
    assert empty["reuniones"] == [] and [m["titulo"] for m in empty["ultimas"]] == ["Formación panel", "Kickoff web"], "hoy ninguna: las últimas"
    assert "ultimas" not in json.loads(asyncio.run(box.call("consultar_reuniones", {"consulta": "nada-parecido"}))), "solo cuando se pidió por fechas"
    assert "ultimas" not in json.loads(asyncio.run(box.call("consultar_reuniones", {"consulta": "nada-parecido", "desde": "2026-11-14", "hasta": "2026-11-14"}))), \
        "si no coincide una palabra, ese día sí hay reuniones"
    assert "ultimas" not in json.loads(asyncio.run(box.call("consultar_reuniones", {"tipo": "entrevista", "desde": "2026-12-01"})))


def test_watson_busca_con_cuidado(database):
    assert [m["titulo"] for m in meeting_tools.find(database, OWNER, "con los del panel")] == ["Formación panel"], "las palabras vacías no cuentan"
    with pytest.raises(ValueError):
        meeting_tools.find(database, OWNER, kind="llamadas")
    with pytest.raises(ValueError):
        meeting_tools.find(database, OWNER, kind=5)


def test_nombres_sin_controles_y_exportar_solo_normales(client, monkeypatch, tmp_path):  # noqa: F811
    assert meetings.classify("meeting", "Acme\x7f\x9b SL", ["A​na"] * 3 + [f"p{n}" for n in range(100)])[1:] == ("Acme SL", [{"name": n, "email": None} for n in ["A na"] + [f"p{n}" for n in range(29)]])
    assert meeting_notes.note_title(". . x") == "x"
    started = client.post("/meetings", json={"mic_type": "audio/webm", "confidentiality": "private"}, headers=H).json()
    client.post(f"/meetings/{started['id']}/stop", headers=H)
    database = connect(client.data / DB_NAME)
    database.execute("UPDATE meeting SET transcript = '[]' WHERE id = ?", (started["id"],))
    database.commit()
    database.close()
    refused = client.post(f"/meetings/{started['id']}/export", headers=H)
    assert refused.status_code == 403 and "no salen" in refused.json()["error"]


def test_contactos_para_con_quien(client, monkeypatch):  # noqa: F811
    from agora_core import calls
    people = [{"name": "Ana López", "org": "Acme", "emails": ["ana@acme.com"]}, {"name": "Juan Anaya", "org": None, "emails": []},
              {"name": "Luis", "org": "Beta", "emails": ["l@beta.com"]}]
    book = calls.FakeContacts(people=people)
    monkeypatch.setattr(calls, "shared_contacts", lambda: book)
    found = client.get("/meetings/contacts?q=ana", headers=H).json()
    assert found["status"] == "granted" and [c["name"] for c in found["contacts"]] == ["Ana López", "Juan Anaya"], "la palabra que empieza va primero"
    assert found["contacts"][0] == {"name": "Ana López", "org": "Acme", "email": "ana@acme.com"}
    assert [c["name"] for c in client.get("/meetings/contacts?q=beta.com", headers=H).json()["contacts"]] == ["Luis"]
    monkeypatch.setattr(calls, "shared_contacts", lambda: calls.FakeContacts(people=people, status="denied"))
    assert client.get("/meetings/contacts?q=ana", headers=H).json() == {"status": "denied", "contacts": []}
    assert meetings.people_of('["Ana"]') == [{"name": "Ana", "email": None}], "las guardadas antes eran solo nombres"


def test_un_correo_pegado_no_se_queda_en_el_nombre():
    people = meetings.classify("meeting", None, ["Ana López <Ana@Acme.com>", "l@beta.com", {"name": "Rus", "email": "x@correo.xn--p1ai"}])[2]
    assert people == [{"name": "Ana López", "email": "ana@acme.com"}, {"name": "l", "email": "l@beta.com"}, {"name": "Rus", "email": "x@correo.xn--p1ai"}]


def test_note_title_names_the_client_once_as_a_whole_word():
    from agora_core import meeting_notes
    base = {"transcript": "[]", "summary": None, "people": "[]", "started_at": "2026-11-17T10:00:00Z", "ended_at": "2026-11-17T10:30:00Z",
            "kind": "meeting", "project": None, "confidentiality": "normal"}
    inside = meeting_notes.note({**base, "client": "Ana", "title": "Planificación de mañana"})
    assert inside["title"].endswith("Ana · Planificación de mañana"), "«Ana» dentro de «mañana» no cuenta"
    named = meeting_notes.note({**base, "client": "Acme", "title": "Revisión con ACME"})
    assert named["title"].endswith("Revisión con ACME") and "# Revisión con ACME" in named["content"]
    alone = meeting_notes.note({**base, "client": None, "title": "Equipo semanal"})
    assert alone["title"].endswith("Equipo semanal")
