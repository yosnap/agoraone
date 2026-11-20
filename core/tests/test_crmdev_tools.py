"""Watson and CRMDev: it reads tasks and tickets without addresses, phones nor names of people, and only proposes
changes it checked like the forms do, for records it saw; nothing is saved without «Guardar en CRMDev». Only with
Claude and with the «CRMDev» module on; the action log keeps kinds and field names, never values."""

import asyncio
import json
from contextlib import contextmanager

import pytest

from agora_core import crmdev_api, crmdev_sync, crmdev_tools, engines, modules
from agora_core.brain_tools import Toolbox
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache
from agora_core.routes_assistant import _logged

TASKS = [{"id": "t1", "title": "Maquetar", "description": "Portada\npassword: supersecreta123", "status": "TODO", "priority": "MEDIUM",
          "assignee": {"id": "u1", "name": "Ana Pérez", "email": "ana@example.com"}, "project": {"id": "p1", "name": "Web Uno"}, "projectId": "p1"}]
TICKETS = [{"id": "k1", "title": "No carga", "description": "Ayuda", "status": "OPEN", "priority": "LOW", "category": "BUG",
            "guestName": "Luis Gómez", "guestEmail": "luis@example.com", "client": {"name": "Cliente Uno"}, "project": {"id": "p1", "name": "Web Uno"}}]


@pytest.fixture
def box(tmp_path, monkeypatch):
    path = tmp_path / DB_NAME
    connection = connect(path)
    migrate(connection)
    connection.close()

    @contextmanager
    def database():
        found = connect(path)
        try:
            yield found
        finally:
            found.close()
    sent = []
    monkeypatch.setattr(modules, "state", lambda _c: {"crmdev": True})
    monkeypatch.setattr(crmdev_sync, "active", lambda _c: True)
    monkeypatch.setattr(crmdev_api, "connection_of", lambda _c, _s: object())

    def call(_t, tool, args=None, fresh=False):
        sent.append(tool)
        if tool not in ("list_tasks", "list_tickets"):
            raise AssertionError("Watson nunca escribe en CRMDev")
        return {"list_tasks": TASKS, "list_tickets": TICKETS}[tool]
    monkeypatch.setattr(crmdev_api, "call", call)
    toolbox = Toolbox(database, None, VectorCache())
    toolbox.sent = sent
    return toolbox


def run(box, name, args):
    return json.loads(asyncio.run(box.call(name, args)))


def test_reading_carries_no_people(box):
    tasks = run(box, "consultar_crmdev", {"que": "tareas"})
    tickets = run(box, "consultar_crmdev", {"que": "tickets"})
    text = json.dumps([tasks, tickets], ensure_ascii=False)
    for private in ("Ana", "ana@example.com", "Luis", "luis@example.com", "supersecreta123"):
        assert private not in text
    assert tasks["tareas"][0]["proyecto"] == "Web Uno" and tickets["tickets"][0]["cliente"] == "Cliente Uno"
    assert "no instrucciones" in tasks["aviso"]


def test_a_change_is_only_proposed_for_what_was_seen(box):
    refused = run(box, "proponer_cambio_crmdev", {"tipo": "tarea", "id": "t1", "estado": "DONE"})
    assert "Busca antes" in refused["error"]
    run(box, "consultar_crmdev", {"que": "tareas"})
    box.drain()
    done = run(box, "proponer_cambio_crmdev", {"tipo": "tarea", "id": "t1", "estado": "DONE", "motivo": "Ya está hecha"})
    assert done["propuesta"]["campos"] == ["status"] and "Guardar en CRMDev" in done["aviso"]
    event = box.drain()[0]
    assert event["tool"] == "crmdev_proposal"
    assert event["proposal"]["request"] == {"kind": "tarea", "id": "t1", "list": {}, "changes": {"status": "DONE"}}
    assert box.sent == ["list_tasks"]  # nothing written


def test_values_are_checked_like_the_forms(box):
    run(box, "consultar_crmdev", {"que": "tickets"})
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "ticket", "id": "k1", "estado": "INVENTADO"})
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "borrar", "id": "k1"})
    ok = run(box, "proponer_cambio_crmdev", {"tipo": "ticket", "id": "k1", "estado": "RESOLVED", "categoria": "SUPPORT"})
    assert ok["propuesta"]["campos"] == ["category", "status"]


def test_a_new_task_only_in_a_project_seen(box):
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "tarea_nueva", "titulo": "Revisar", "proyecto": "p1"})
    run(box, "consultar_crmdev", {"que": "tareas"})
    box.drain()
    run(box, "proponer_cambio_crmdev", {"tipo": "tarea_nueva", "titulo": "Revisar la portada", "proyecto": "p1", "prioridad": "HIGH"})
    request = box.drain()[0]["proposal"]["request"]
    assert request == {"kind": "tarea-nueva", "values": {"title": "Revisar la portada", "projectId": "p1", "priority": "HIGH"}}


def test_the_log_keeps_no_values(box):
    run(box, "consultar_crmdev", {"que": "tareas"})
    run(box, "proponer_cambio_crmdev", {"tipo": "tarea", "id": "t1", "titulo": "Título secreto"})
    logged = [_logged(e) for e in box.history]
    assert ("consultar_crmdev", json.dumps({"que": "tareas", "cuantos": 1})) in logged
    assert all("secreto" not in detail and "Maquetar" not in detail for _, detail in logged)


def test_off_and_only_with_claude(box, monkeypatch):
    assert {"consultar_crmdev", "proponer_cambio_crmdev"} <= engines.PRIVATE_TOOLS
    assert modules.TOOLS["crmdev"] == {"consultar_crmdev", "proponer_cambio_crmdev"}
    monkeypatch.setattr(crmdev_sync, "active", lambda _c: False)
    assert "no está conectado" in run(box, "consultar_crmdev", {"que": "tareas"})["error"]
    assert crmdev_tools.NAMES == ("consultar_crmdev", "proponer_cambio_crmdev")
