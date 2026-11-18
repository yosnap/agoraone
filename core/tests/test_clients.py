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
    clients.create(db, {"name": "Café Web", "email": "Hola@CafeWeb.es", "phone": "600 111 222", "taxId": "b12345678", "domains": ["www.cafeweb.com"]})
    clients.create(db, {"name": "Gmail Persona", "email": "persona@gmail.com"})
    assert clients.match(db, address="hola@cafeweb.es")["name"] == "Café Web"
    assert clients.match(db, address="ana@cafeweb.es")["name"] == "Café Web", "por el dominio del correo"
    assert clients.match(db, address="ana@shop.cafeweb.com")["name"] == "Café Web", "por un subdominio de su dominio"
    assert clients.match(db, phone="+34 600-111-222")["name"] == "Café Web", "guardado sin prefijo: por los últimos nueve"
    assert clients.match(db, phone="0034600111222")["name"] == "Café Web"
    assert clients.match(db, tax_id="ES-B12345678")["name"] == "Café Web"
    assert clients.match(db, address="persona@gmail.com")["name"] == "Gmail Persona", "la dirección exacta sí"
    assert clients.match(db, address="otra@gmail.com") is None, "un dominio gratuito nunca casa"
    with pytest.raises(clients.ClientError, match="gratuito"):
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
    assert answer["clientes"] == [{"nombre": "Café Web", "empresa": None, "origen": "local", "dominios": ["cafeweb.com", "cafeweb.es"], "webs": [],
                                   "proyectos_activos": []}]
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
    assert found == {"normal": {"name": "Café Web"}, "private": None}


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
        assert client.delete(f"/clients/{local_id}", headers=headers).json() == {"deleted": True}
        assert client.delete(f"/clients/{local_id}", headers=headers).status_code == 404
