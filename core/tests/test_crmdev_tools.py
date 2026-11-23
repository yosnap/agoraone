"""Watson and CRMDev: it reads tasks and tickets without addresses, phones nor names of people, and only proposes
changes it checked like the forms do, for records it saw; nothing is saved without «Guardar en CRMDev». Only with
Claude and with the «CRMDev» module on; the action log keeps kinds and field names, never values."""

import asyncio
import json
from contextlib import contextmanager

import pytest

from agora_core import crmdev_api, crmdev_orgs, crmdev_sync, crmdev_tools, engines, modules
from agora_core.brain_tools import Toolbox
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache
from agora_core.routes_assistant import _logged

TASKS = [{"id": "t1", "title": "Maquetar", "description": "Portada\npassword: supersecreta123", "status": "TODO", "priority": "MEDIUM",
          "assignee": {"id": "u1", "name": "Ana Pérez", "email": "ana@example.com"}, "project": {"id": "p1", "name": "Web Uno"}, "projectId": "p1"}]
TICKETS = [{"id": "k1", "title": "No carga", "description": "Ayuda", "status": "OPEN", "priority": "LOW", "category": "BUG",
            "guestName": "Luis Gómez", "guestEmail": "luis@example.com", "client": {"name": "Cliente Uno"}, "project": {"id": "p1", "name": "Web Uno"}},
           {"id": "k2", "title": "Otro", "status": "OPEN", "client": {"name": "Cliente Dos"}}]
CLIENTS = [{"id": "c1", "name": "Cliente Uno", "company": "Uno SL", "email": "hola@uno.example", "phone": "600 111 222", "status": "CUSTOMER",
            "apiToken": "no-debe-salir", "tags": ["x"]}]


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
    orgs = [{"id": "o1", "name": "Primera"}]
    monkeypatch.setattr(crmdev_orgs, "orgs", lambda _c: orgs)
    monkeypatch.setattr(crmdev_orgs, "connection_of", lambda _c, _s, org=None: org)  # the «connection» says its organization
    rows = {"o1": {"list_tasks": TASKS, "list_tickets": TICKETS, "list_clients": CLIENTS}, "o2": {"list_tasks": [{**TASKS[0], "title": "De la segunda"}], "list_tickets": []}}

    def call(target, tool, args=None, fresh=False):
        sent.append(tool)
        if tool not in ("list_tasks", "list_tickets", "list_clients"):
            raise AssertionError("Watson nunca escribe en CRMDev")
        return rows[target][tool]
    monkeypatch.setattr(crmdev_api, "call", call)
    toolbox = Toolbox(database, None, VectorCache())
    toolbox.sent = sent
    toolbox.orgs = orgs
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
    assert event["proposal"]["request"] == {"kind": "tarea", "id": "t1", "list": {}, "changes": {"status": "DONE"}, "org": "o1"}
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
    assert request == {"kind": "tarea-nueva", "values": {"title": "Revisar la portada", "projectId": "p1", "priority": "HIGH"}, "org": "o1"}


def test_each_organization_is_read_and_a_proposal_goes_to_the_record_s_own(box):
    box.orgs.append({"id": "o2", "name": "Segunda"})
    found = run(box, "consultar_crmdev", {"que": "tareas"})["tareas"]
    assert [(t["titulo"], t["organizacion"]) for t in found] == [("Maquetar", "Primera"), ("De la segunda", "Segunda")]
    assert [t["titulo"] for t in run(box, "consultar_crmdev", {"que": "tareas", "organizacion": "segunda"})["tareas"]] == ["De la segunda"]
    assert "error" in run(box, "consultar_crmdev", {"que": "tareas", "organizacion": "Tercera"})
    box.drain()
    # The same id in both organizations: ambiguous, so it is refused rather than guessed.
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "tarea", "id": "t1", "estado": "DONE"})
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "tarea_nueva", "titulo": "Sin proyecto"})
    box.crmdev_seen.discard(("tareas", "t1", "o1"))
    run(box, "proponer_cambio_crmdev", {"tipo": "tarea", "id": "t1", "estado": "DONE"})
    proposal = box.drain()[0]["proposal"]
    assert (proposal["org"], proposal["orgName"], proposal["request"]["org"]) == ("o2", "Segunda", "o2")


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


def test_a_reply_to_a_ticket_seen_says_who_reads_it(box):
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "respuesta_ticket", "id": "k1", "respuesta": "Hola", "interna": True})
    run(box, "consultar_crmdev", {"que": "tickets"})
    box.drain()
    assert "nota interna" in run(box, "proponer_cambio_crmdev", {"tipo": "respuesta_ticket", "id": "k1", "respuesta": "Hola"})["error"]
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "respuesta_ticket", "id": "k1", "respuesta": "", "interna": False})
    run(box, "proponer_cambio_crmdev", {"tipo": "respuesta_ticket", "id": "k1", "respuesta": "Ya está arreglado.", "interna": False})
    request = box.drain()[0]["proposal"]["request"]
    assert request == {"kind": "respuesta-ticket", "id": "k1", "list": {}, "content": "Ya está arreglado.", "internal": False, "org": "o1"}
    assert box.sent == ["list_tickets"]  # nothing written


def test_organizations_clients_and_tickets_of_a_client(box):
    box.orgs.append({"id": "o2", "name": "Segunda"})
    assert run(box, "consultar_crmdev", {"que": "organizaciones"}) == {"organizaciones": ["Primera", "Segunda"], "total": 2}
    # A client with all of its data (user's decision, 23/11/2026), never a field that looks like a key.
    client = run(box, "consultar_crmdev", {"que": "clientes", "organizacion": "Primera", "cliente": "uno"})["clientes"][0]
    assert client == {"id": "c1", "name": "Cliente Uno", "company": "Uno SL", "email": "hola@uno.example", "phone": "600 111 222", "status": "CUSTOMER"}
    tickets = run(box, "consultar_crmdev", {"que": "tickets", "organizacion": "Primera", "cliente": "dos"})["tickets"]
    assert [t["id"] for t in tickets] == ["k2"]


def test_a_new_client_goes_to_the_organization_the_user_says(box):
    box.orgs.append({"id": "o2", "name": "Segunda"})
    # With several organizations and none said, Watson must ask first.
    assert "pregunta" in run(box, "proponer_cambio_crmdev", {"tipo": "cliente_nuevo", "nombre": "Nuevo"})["error"]
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "cliente_nuevo", "nombre": "Nuevo", "organizacion": "Tercera"})
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "cliente_nuevo", "nombre": "Nuevo", "correo": "no-es-correo", "organizacion": "Segunda"})
    assert "error" in run(box, "proponer_cambio_crmdev", {"tipo": "cliente_nuevo", "organizacion": "Segunda"})
    answer = run(box, "proponer_cambio_crmdev", {"tipo": "cliente_nuevo", "nombre": "Nuevo", "empresa": "Nuevo SL", "correo": "a@nuevo.example",
                                                 "telefono": "600 000 000", "organizacion": "segunda"})
    assert "pulse «Guardar en CRMDev»" in answer["aviso"]
    proposal = box.drain()[-1]["proposal"]
    assert proposal["request"] == {"kind": "cliente-nuevo", "org": "o2",
                                   "values": {"name": "Nuevo", "company": "Nuevo SL", "email": "a@nuevo.example", "phone": "600 000 000"}}
    assert proposal["orgName"] == "Segunda" and proposal["orgs"] == [{"id": "o1", "name": "Primera"}, {"id": "o2", "name": "Segunda"}]
    assert "create_client" not in box.sent  # nothing is written: only the card
