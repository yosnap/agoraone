"""The user's clients: kept in AgoraOne without Central, one directory with Central's, linked without duplicates
(same tax id or exact address by itself; alike names only as a suggestion the user confirms) and never exposing an
address, phone or tax id to the screen's lists nor to Watson."""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from agora_core import central, chat_inbox, clients, fiscal, mail, mail_inbox, meetings, modules
from agora_core.app import SECRET_HEADER, create_app
from agora_core.brain_tools import Toolbox
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

SECRET, OWNER = "a" * 64, "b" * 64
RAW = {
    "clients": [{"id": "c1", "name": "Cafe Web SL"}, {"id": "c2", "name": "Acmé"}, {"id": "c3", "name": "Otra Cosa"}],
    "projects": [{"id": "p1", "name": "Tienda", "status": "ACTIVE", "client": "Cafe Web SL"}],
    "websites": [],
    "servers": [],
    "details": {"Cafe Web SL": {"email": "hola@cafeweb.es", "taxId": "ESB-1234567-8", "phone": "+34 600 111 222"},
                "Otra Cosa": {"taxId": "B11111111"}},
}


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def with_central(db, tmp_path, raw=RAW):
    central.refresh(db, tmp_path, fetch=lambda folder: raw)
    assert modules.state(db)["central"], "una instantánea leída enciende Central mientras el usuario no lo toque"


def mail_from(db, address: str) -> None:
    account = mail.create_account(db, {"address": "yo@gmail.com", "provider": "gmail"})
    message = db.execute("""INSERT INTO mail_message (account_id, folder, uidvalidity, uid, from_address, subject, body, sent_at, received_at)
                            VALUES (?, 'INBOX', 1, 1, ?, 'Cambios', 'x', '2026-11-14T10:00:00Z', '2026-11-14T10:00:00Z')""",
                         (account, address)).lastrowid
    db.execute("INSERT INTO mail_summary (message_id, kind, source, confidentiality, created_at) VALUES (?, 'client', 'model', 'normal', 'x')", (message,))


def watson(tmp_path, query: str = "") -> dict:
    class Database:
        def __enter__(self):
            self.connection = connect(tmp_path / "data" / DB_NAME)
            return self.connection

        def __exit__(self, *exc):
            self.connection.close()
    return json.loads(asyncio.run(Toolbox(Database, None, VectorCache()).call("consultar_clientes", {"cliente": query})))


def test_sin_central_un_cliente_propio_casa_por_correo_dominio_telefono_y_nif(db, tmp_path):
    clients.create(db, {"name": "Café Web", "email": "Hola@CafeWeb.es", "phone": "600 111 222", "taxId": "b12345678", "domains": ["www.cafeweb.com", "cafeweb.es"]})
    clients.create(db, {"name": "Gmail Persona", "email": "persona@gmail.com"})
    assert clients.match(db, address="hola@cafeweb.es")["name"] == "Café Web"
    assert clients.match(db, address="ana@cafeweb.es")["name"] == "Café Web", "por un dominio que escribió el usuario"
    assert clients.match(db, address="ana@shop.cafeweb.com")["name"] == "Café Web", "por un subdominio de su dominio"
    assert clients.match(db, phone="+34 600-111-222")["name"] == "Café Web", "guardado sin prefijo: por los últimos nueve"
    assert clients.match(db, phone="0034600111222")["name"] == "Café Web"
    assert clients.match(db, tax_id="ES-B12345678")["name"] == "Café Web"
    assert clients.match(db, address="persona@gmail.com")["name"] == "Gmail Persona", "la dirección exacta sí"
    assert clients.match(db, address="otra@gmail.com") is None, "un dominio gratuito nunca casa"
    with pytest.raises(clients.ClientError, match="comparte mucha gente"):
        clients.create(db, {"name": "Otro", "domains": ["gmail.com"]})
    with pytest.raises(clients.ClientError, match="Ya tienes"):
        clients.create(db, {"name": "  café   WEB "})
    # The Bandeja, a meeting, Watson and Fiscal know it, without Central.
    mail_from(db, "ana@cafeweb.es")
    assert mail_inbox.inbox(db)[0]["client"] == {"name": "Café Web", "projects": []}
    assert meetings.central_client(db, "café web") == "Café Web"
    with pytest.raises(meetings.MeetingError, match="sin proyectos"):
        meetings.central_project(db, "Café Web", "Tienda")
    with pytest.raises(meetings.MeetingError, match="no está entre tus clientes"):
        meetings.central_client(db, "Desconocido")
    answer = watson(tmp_path, "café")
    # Watson knows all of its data (user's decision, 23/11/2026), for a quote or a new client.
    assert answer["clientes"] == [{"nombre": "Café Web", "empresa": None, "correo": "hola@cafeweb.es", "telefono": "600 111 222", "nif": "B12345678",
                                   "origen": "local", "dominios": ["cafeweb.com", "cafeweb.es"], "webs": [], "proyectos_activos": []}]
    # A private mail is matched to no client.
    db.execute("UPDATE mail_summary SET confidentiality = 'private'")
    assert mail_inbox.inbox(db)[0]["client"] is None
    assert fiscal.with_clients(db, [{"taxId": "B-12345678"}, {"taxId": "X"}]) == [{"taxId": "B-12345678", "knownClient": "Café Web"}, {"taxId": "X"}]


def test_el_telefono_corto_solo_con_un_candidato_y_sin_prefijo_guardado(db):
    clients.create(db, {"name": "Uno", "phone": "600111222"})
    clients.create(db, {"name": "Dos", "phone": "+44 600111222"})
    assert clients.match(db, phone="34600111222")["name"] == "Uno", "Dos lleva prefijo: no cuenta por los últimos nueve"
    clients.create(db, {"name": "Tres", "phone": "600 111 222"})
    assert clients.match(db, phone="34600111222") is None, "dos candidatos: no se adivina"
    assert clients.match(db, phone="600111222") is None, "igualdad exacta con dos: tampoco"


def test_con_central_y_el_mismo_nif_se_ve_una_vez(db, tmp_path):
    own = clients.create(db, {"name": "Café Web", "taxId": "B12345678", "notes": "Paga a 30 días"})
    with_central(db, tmp_path)
    entries, suggestions = clients.build(db)
    cafe = [e for e in entries if e["localId"] == own["localId"] or e["centralId"] == "c1"]
    assert len(cafe) == 1 and cafe[0]["source"] == "ambos" and cafe[0]["name"] == "Cafe Web SL" and cafe[0]["aliases"] == ["Café Web"]
    assert cafe[0]["projects"][0]["name"] == "Tienda" and suggestions == []
    assert meetings.central_client(db, "Café Web") == "Cafe Web SL", "el nombre propio sigue valiendo"
    assert meetings.central_project(db, "Cafe Web SL", "tienda") == "Tienda"
    # Same exact address, too; a free mail domain never links by domain.
    clients.update(db, own["localId"], {"taxId": None, "email": "hola@cafeweb.es"})
    assert [e["source"] for e in clients.directory(db) if e["centralId"] == "c1"] == ["ambos"]


def test_nombre_parecido_es_sugerencia_y_son_distintos_impide_enlazar(db, tmp_path):
    own = clients.create(db, {"name": "Acme"})
    with_central(db, tmp_path)
    entries, suggestions = clients.build(db)
    assert sorted(e["source"] for e in entries if clients.loose(e["name"]) == "acme") == ["central", "local"], "parecido: no se enlaza solo"
    assert suggestions == [{"localId": own["localId"], "localName": "Acme", "centralId": "c2", "centralName": "Acmé"}]
    clients.set_link(db, own["localId"], "c2", "linked")
    entries, suggestions = clients.build(db)
    assert [e["source"] for e in entries if clients.loose(e["name"]) == "acme"] == ["ambos"] and suggestions == []
    clients.set_link(db, own["localId"], "c2", "distinct")
    entries, suggestions = clients.build(db)
    assert sorted(e["source"] for e in entries if clients.loose(e["name"]) == "acme") == ["central", "local"] and suggestions == []
    # «Son distintos» also stops a link by the same tax id, and nothing is deleted.
    other = clients.create(db, {"name": "Otra", "taxId": "B11111111"})
    assert [e["source"] for e in clients.directory(db) if e["centralId"] == "c3"] == ["ambos"], "mismo NIF: se enlaza solo"
    clients.set_link(db, other["localId"], "c3", "distinct")
    assert sorted(e["source"] for e in clients.directory(db) if e["name"] in ("Otra", "Otra Cosa")) == ["central", "local"]
    assert len(clients.local(db)) == 2
    with pytest.raises(clients.ClientError, match="no está en Central"):
        clients.set_link(db, own["localId"], "inexistente", "linked")


def test_central_apagado_o_desconectado_devuelve_solo_los_propios(db, tmp_path):
    clients.create(db, {"name": "Café Web", "taxId": "B12345678"})
    with_central(db, tmp_path)
    modules.save(db, {"central": False})
    assert [(e["name"], e["source"]) for e in clients.directory(db)] == [("Café Web", "local")]
    modules.save(db, {"central": True})
    assert len(clients.directory(db)) == 3
    assert len(clients.local(db)) == 1, "nada se borra"


def test_whatsapp_casa_por_telefono_y_nunca_lo_privado(db):
    clients.create(db, {"name": "Café Web", "phone": "600111222"})
    account = db.execute("INSERT INTO chat_account (remote_id, phone, created_at) VALUES ('a', '+34000', 'x')").lastrowid
    for remote, level in (("r1", "normal"), ("r2", "private")):
        conversation = db.execute("""INSERT INTO chat_conversation (account_id, remote_id, participant_phone)
                                     VALUES (?, ?, '+34 600 111 222')""", (account, remote)).lastrowid
        db.execute("INSERT INTO chat_summary (conversation_id, kind, source, confidentiality, updated_at) VALUES (?, 'client', 'model', ?, 'x')",
                   (conversation, level))
    found = {s["confidentiality"]: s["client"] for s in chat_inbox.summaries(db)}
    assert found == {"normal": {"name": "Café Web", "projects": []}, "private": None}


def test_rutas_sin_contacto_en_la_lista_y_sin_clave_rechazadas(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None), base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        assert client.get("/clients").status_code in (401, 403)
        made = client.post("/clients", json={"name": "Café Web", "email": "hola@cafeweb.es", "phone": "600111222", "taxId": "B12345678",
                                             "notes": "privado"}, headers=headers)
        assert made.status_code == 201 and made.json()["email"] == "hola@cafeweb.es"
        listing = client.get("/clients", headers=headers).json()
        text = json.dumps(listing)
        assert listing["clients"][0]["name"] == "Café Web" and listing["central"] == {"on": False, "read": False}
        assert all(word not in text for word in ("hola@cafeweb.es", "600111222", "B12345678", "privado", '"email"', '"phone"', '"taxId"', '"notes"'))
        local_id = made.json()["localId"]
        assert client.get(f"/clients/{local_id}", headers=headers).json()["taxId"] == "B12345678"
        assert client.post("/clients", json={"name": " "}, headers=headers).status_code == 422
        assert client.patch(f"/clients/{local_id}", json={"email": "no-es-correo"}, headers=headers).status_code == 422
        assert client.patch(f"/clients/{local_id}", json={"company": "Café Web SL"}, headers=headers).json()["company"] == "Café Web SL"
        assert client.post(f"/clients/{local_id}/link", json={"centralId": "c1"}, headers=headers).status_code == 422
        assert client.delete(f"/clients/{local_id}", headers=headers).json() == {"deleted": True, "references": {"meetings": 0}}
        assert client.delete(f"/clients/{local_id}", headers=headers).status_code == 404


def test_un_enlace_confirmado_gana_a_uno_automatico(db, tmp_path):
    clients.create(db, {"name": "Aardvark", "taxId": "B11111111"})
    zeta = clients.create(db, {"name": "Zeta"})
    with_central(db, tmp_path, {**RAW, "details": {"Otra Cosa": {"taxId": "B11111111"}}})
    clients.set_link(db, zeta["localId"], "c3", "linked")
    clients.create(db, {"name": "otra cosa"})
    entries = clients.directory(db)
    merged = next(e for e in entries if e["centralId"] == "c3")
    assert merged["source"] == "ambos" and merged["localId"] == zeta["localId"] and merged["aliases"] == ["Zeta"]
    assert [e["name"] for e in entries if e["source"] == "local"] == ["Aardvark", "otra cosa"], "ni el mismo NIF ni el mismo nombre le roban el enlace"
    assert meetings.central_client(db, "Zeta") == "Otra Cosa"


def test_el_dominio_del_correo_de_un_propio_no_cuenta_y_los_compartidos_se_rechazan(db, tmp_path):
    clients.create(db, {"name": "Pepe", "email": "pepe@hotmail.es"})
    clients.create(db, {"name": "Juan", "email": "juan@juanperez.es"})
    assert clients.match(db, address="otro@hotmail.es") is None
    assert clients.match(db, address="ana@juanperez.es") is None, "el dominio solo cuenta si el usuario lo escribe"
    assert clients.match(db, address="pepe@hotmail.es")["name"] == "Pepe"
    for shared in ("hotmail.es", "yahoo.co.uk", "telefonica.net", "icloud.es", "gmx.es"):
        assert clients.is_free_mail(shared), shared
        with pytest.raises(clients.ClientError, match="comparte mucha gente"):
            clients.create(db, {"name": f"X {shared}", "domains": [shared]})
    for suffix in ("co.uk", "com.es", "gob.es", "github.io", "vercel.app"):
        with pytest.raises(clients.ClientError, match="sufijo compartido"):
            clients.create(db, {"name": f"Y {suffix}", "domains": [suffix]})
    assert all(c["dominios"] == [] for c in watson(tmp_path)["clientes"]), "Watson no recibe el dominio de un correo personal"
    central.refresh(db, tmp_path, fetch=lambda folder: {**RAW, "details": {"Acmé": {"email": "acme@outlook.es"}}})
    assert next(c for c in clients.directory(db) if c["name"] == "Acmé")["domains"] == []


def test_un_dominio_compartido_por_dos_clientes_no_casa(db):
    clients.create(db, {"name": "Uno", "domains": ["acme.com"]})
    clients.create(db, {"name": "Dos", "domains": ["acme.com"]})
    clients.create(db, {"name": "Tres", "domains": ["eu.acme.com"]})
    assert clients.match(db, address="a@acme.com") is None
    assert clients.match(db, address="a@x.eu.acme.com")["name"] == "Tres", "el dominio más cercano"
    clients.create(db, {"name": "Cuatro", "email": "comun@ejemplo.org"})
    clients.create(db, {"name": "Cinco", "email": "comun@ejemplo.org"})
    assert clients.match(db, address="comun@ejemplo.org") is None


def test_son_distintos_con_el_mismo_nombre_se_rechaza_y_se_guardan_varios_pares(db, tmp_path):
    beta = clients.create(db, {"name": "Cafe Web SL"})
    other = clients.create(db, {"name": "Acme", "taxId": "B11111111"})
    with_central(db, tmp_path, {**RAW, "details": {"Otra Cosa": {"taxId": "B11111111"}}})
    with pytest.raises(clients.ClientError, match="si se llaman igual"):
        clients.set_link(db, beta["localId"], "c1", "distinct")
    clients.set_link(db, other["localId"], "c2", "distinct")
    clients.set_link(db, other["localId"], "c3", "distinct")
    entries, suggestions = clients.build(db)
    assert suggestions == [] and next(e for e in entries if e["localId"] == other["localId"])["source"] == "local", "ni Acmé ni el mismo NIF"
    found = clients.get(db, other["localId"])
    assert found["distinct"] == [{"centralId": "c2", "centralName": "Acmé"}, {"centralId": "c3", "centralName": "Otra Cosa"}]
    clients.set_link(db, other["localId"], "c3", "undistinct")
    assert next(e for e in clients.directory(db) if e["centralId"] == "c3")["localId"] == other["localId"], "deshecho: vuelve a enlazarse por NIF"


def test_renombrar_lleva_el_nombre_a_las_reuniones_y_borrar_guarda_copia(db):
    own = clients.create(db, {"name": "P1", "notes": "Paga a 30 días"})
    db.execute("INSERT INTO meeting (owner, title, status, started_at, mic_type, client) VALUES ('o', 'r', 'recorded', 'x', 'webm', 'P1')")
    assert clients.get(db, own["localId"])["references"] == {"meetings": 1}
    clients.update(db, own["localId"], {"name": "P1 renombrado"})
    assert db.execute("SELECT client FROM meeting").fetchone()[0] == "P1 renombrado"
    assert meetings.central_client(db, "P1 renombrado") == "P1 renombrado"
    gone = clients.delete(db, own["localId"])
    assert gone["references"] == {"meetings": 1} and clients.get(db, own["localId"]) is None
    copy = json.loads(db.execute("SELECT data FROM client_backup").fetchone()[0])
    assert copy["name"] == "P1 renombrado" and copy["notes"] == "Paga a 30 días"
    assert db.execute("SELECT client FROM meeting").fetchone()[0] == "P1 renombrado", "la reunión conserva el nombre"


def test_alta_concurrente_con_el_mismo_nombre_da_conflicto(db, monkeypatch):
    clients.create(db, {"name": "Café Web"})
    monkeypatch.setattr(clients, "_name_taken", lambda *args: False)  # the other request checked before this one wrote
    with pytest.raises(clients.ClientConflict):
        clients.create(db, {"name": "café web"})
