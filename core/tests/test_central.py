import asyncio
import json

import pytest

from agora_core import central, mail, mail_inbox
from agora_core.brain_tools import Toolbox
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache

RAW = {
    "clients": [{"id": "1", "name": "Cliente Uno"}, {"id": "2", "name": "Gmail Persona"}, {"id": "3", "name": "Sin datos"}],
    "projects": [{"id": "p1", "name": "Web Uno", "status": "ACTIVE", "client": "Cliente Uno"},
                 {"id": "p2", "name": "Viejo", "status": "ARCHIVED", "client": "Cliente Uno"},
                 {"id": "p3", "name": "Blog", "status": "ACTIVE", "client": "Gmail Persona"}],
    "websites": [{"url": "https://www.clienteuno.com", "client": "Cliente Uno", "status": "up"}],
    "servers": [{"name": "hetzner-1", "status": "green", "provider": "Hetzner", "projects": [{"name": "Web Uno"}]}],
    "details": {"Cliente Uno": {"email": "Info@ClienteUno.com", "taxId": "B12345678"}, "Gmail Persona": {"email": "persona@gmail.com"}},
}


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def test_instantanea_y_cliente_de_un_remitente(db, tmp_path):
    snap = central.refresh(db, tmp_path, fetch=lambda folder: RAW)
    uno = snap["clients"][0]
    assert uno["domains"] == ["clienteuno.com"] and uno["email"] == "info@clienteuno.com" and uno["taxId"] == "B12345678"
    assert snap["clients"][1]["domains"] == [], "gmail.com no es el dominio de nadie"
    assert snap["servers"] == [{"name": "hetzner-1", "status": "green", "provider": "Hetzner", "projects": ["Web Uno"]}]
    assert central.client_for(db, "ana@clienteuno.com")["name"] == "Cliente Uno"
    assert central.client_for(db, "x@eu.clienteuno.com")["name"] == "Cliente Uno"
    assert central.client_for(db, "persona@gmail.com")["name"] == "Gmail Persona", "por la dirección exacta sí"
    assert central.client_for(db, "otra@gmail.com") is None


def test_central_que_falla_se_dice_claro(db, tmp_path):
    def broken(folder):
        raise OSError("sin base de datos")
    with pytest.raises(central.CentralError, match="base de datos"):
        central.refresh(db, tmp_path, fetch=broken)
    assert central.snapshot(db) is None
    assert central.READING_TOOLS.isdisjoint({"create_quote", "update_phase", "add_note"}), "solo herramientas de lectura"


def test_la_bandeja_y_watson_conocen_al_cliente(db, tmp_path):
    central.refresh(db, tmp_path, fetch=lambda folder: RAW)
    account = mail.create_account(db, {"address": "yo@gmail.com", "provider": "gmail"})
    message = db.execute("""INSERT INTO mail_message (account_id, folder, uidvalidity, uid, from_address, subject, body, sent_at, received_at)
                            VALUES (?, 'INBOX', 1, 1, 'ana@clienteuno.com', 'Cambios', 'x', '2026-11-14T10:00:00Z', '2026-11-14T10:00:00Z')""",
                         (account,)).lastrowid
    db.execute("INSERT INTO mail_summary (message_id, kind, source, confidentiality, created_at) VALUES (?, 'client', 'model', 'normal', 'x')", (message,))
    assert mail_inbox.inbox(db)[0]["client"] == {"name": "Cliente Uno", "projects": ["Web Uno"]}

    class Database:
        def __enter__(self):
            self.connection = connect(tmp_path / "data" / DB_NAME)
            return self.connection

        def __exit__(self, *exc):
            self.connection.close()
    answer = json.loads(asyncio.run(Toolbox(Database, None, VectorCache()).call("consultar_clientes", {"cliente": "uno"})))
    assert answer["clientes"][0]["proyectos_activos"] == ["Web Uno"] and answer["servidores"][0]["estado"] == "green"
