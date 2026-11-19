"""Changes to CRMDev from AgoraOne: nothing that deletes can leave (whatever the screen sends), each kind of change shows
its exact before and after, a change of a record is checked again before it is sent, a token is sent once, a new client
is never duplicated, and the cache is emptied after a change. CRMDev is a stand-in with the shape of its
`src/app/api/mcp/rest/route.ts` and invented data that remembers what it is sent."""

import copy
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import brain_tools, confirmed_change, crmdev_api, crmdev_write, modules
from agora_core.db import DB_NAME, connect
from test_assistant import MemorySecrets
from test_central_api import HEADERS, app_with
from test_crmdev_api import DELETES, KEY, URL

ROWS = {
    "list_projects": [{"id": "p1", "name": "Web Uno", "status": "IN_PROGRESS", "progress": 40, "type": "GITHUB", "deadline": None}],
    "list_tasks": [{"id": "t1", "title": "Maquetar", "description": "Portada", "status": "TODO", "priority": "MEDIUM", "dueDate": None,
                    "assigneeId": "u1", "assignee": {"id": "u1", "name": "Ana", "email": "ana@example.com"}, "project": {"name": "Web Uno"},
                    "projectId": "p1"}],
    "list_clients": [{"id": "c1", "name": "Cliente Uno", "email": "info@cliente.example", "company": "Uno SL", "status": "CUSTOMER"}],
    "list_tickets": [{"id": "k1", "title": "No carga", "description": "Ayuda", "status": "OPEN", "priority": "LOW", "category": "BUG",
                      "guestName": "Luis", "guestEmail": "luis@example.com", "createdAt": None, "updatedAt": None, "client": {"name": "Cliente Uno"},
                      "clientId": "c1", "project": None}],
    "list_members": [{"user": {"id": "u1", "name": "Ana", "email": "ana@example.com", "image": None}, "role": "owner"}],
}
UPDATES = {"update_task": ("list_tasks", "taskId"), "update_project": ("list_projects", "projectId"), "update_client": ("list_clients", "clientId"),
           "update_ticket": ("list_tickets", "ticketId")}
FILTERS = {"status": "status", "projectId": "projectId", "clientId": "clientId"}


class StatefulCrmdev:
    """Answers like CRMDev's REST API and applies what it is sent, so a second reading sees the change."""

    def __init__(self):
        self.rows = copy.deepcopy(ROWS)
        self.seen: list[dict] = []
        self.fail_write: httpx.Response | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != f"Bearer {KEY}":
            return httpx.Response(403, json={"error": "Invalid API Key"})
        if request.method == "GET":
            return httpx.Response(200, json={"success": True, "tools": {}, "count": 0})
        body = json.loads(request.content)
        tool, args = body["tool"], body["arguments"]
        self.seen.append(body)
        if tool.startswith("delete_"):
            raise AssertionError("AgoraOne nunca debe pedir un borrado")
        if tool.startswith("list_"):
            found = [r for r in self.rows[tool] if all(r.get(FILTERS[k]) == v for k, v in args.items() if k in FILTERS)]
            return httpx.Response(200, json={"success": True, "data": found[: args.get("limit", 20)]})
        if self.fail_write is not None:
            return self.fail_write
        if tool in UPDATES:
            table, key = UPDATES[tool]
            row = next(r for r in self.rows[table] if r["id"] == args[key])
            row.update({k: v for k, v in args.items() if k != key})
            return httpx.Response(200, json={"success": True, "data": {"id": row["id"]}})
        table = {"create_task": "list_tasks", "create_client": "list_clients"}[tool]
        made = {"id": f"n{len(self.rows[table]) + 1}", **args}
        self.rows[table].insert(0, made)
        return httpx.Response(200, json={"success": True, "data": {"id": made["id"]}})

    def tools(self) -> list[str]:
        return [b["tool"] for b in self.seen]

    def writes(self) -> list[dict]:
        return [b for b in self.seen if not b["tool"].startswith("list_")]


@pytest.fixture(autouse=True)
def empty_cache():
    crmdev_api.clear_cache()
    yield
    crmdev_api.clear_cache()


@pytest.fixture
def fake(monkeypatch):
    found = StatefulCrmdev()
    monkeypatch.setattr(crmdev_api, "TRANSPORT", httpx.MockTransport(found))
    return found


@pytest.fixture
def setup(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/connectors/crmdev", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        yield client, settings


def preview(client, body):
    return client.post("/crmdev/write/preview", json=body, headers=HEADERS)


def confirm(client, token):
    return client.post("/crmdev/write/confirm", json={"token": token}, headers=HEADERS)


def test_ninguna_herramienta_de_escritura_borra():
    assert not any(name.startswith("delete_") for name in crmdev_api.WRITE_TOOLS)
    assert set(crmdev_write.KIND_TOOL.values()) <= crmdev_api.WRITE_TOOLS
    assert set(crmdev_write.KIND_TOOL.values()) == crmdev_api.WRITE_TOOLS, "cada herramienta de escritura tiene su clase de cambio"


@pytest.mark.parametrize("kind", ["borrar", "delete_task", "delete_client", "tarea ", "", "TAREA"])
def test_una_clase_inventada_no_hace_ninguna_peticion(setup, fake, kind):
    client, _ = setup
    answer = preview(client, {"kind": kind, "id": "t1", "changes": {"title": "x"}})
    assert answer.status_code == 422 and fake.seen == []


@pytest.mark.parametrize("extra", [{"tool": "delete_task"}, {"tool": "update_task"}, {"arguments": {"taskId": "t1"}}])
def test_la_pantalla_no_elige_la_herramienta(setup, fake, extra):
    client, _ = setup
    answer = preview(client, {"kind": "tarea", "id": "t1", "changes": {"title": "Nuevo"}, **extra})
    assert answer.status_code == 422 and fake.seen == [], "no sale ninguna petición"


def test_cada_borrado_lo_para_el_transporte_aunque_se_salte_la_ruta(fake):
    target = crmdev_api.Connection(URL, KEY)
    for tool in DELETES:
        with pytest.raises(crmdev_api.WebApiError):
            crmdev_api.call(target, tool, {"taskId": "t1"})
    assert fake.seen == []


@pytest.mark.parametrize("body, rows, tool", [
    ({"kind": "tarea", "id": "t1", "changes": {"title": "  Maquetar portada ", "status": "IN_REVIEW", "priority": "MEDIUM"}},
     [("title", "Maquetar", "Maquetar portada"), ("status", "Por hacer", "En revisión")], "update_task"),
    ({"kind": "proyecto", "id": "p1", "changes": {"progress": 75, "status": "ON_HOLD"}},
     [("status", "En curso", "En pausa"), ("progress", "40 %", "75 %")], "update_project"),
    ({"kind": "cliente", "id": "c1", "changes": {"company": "", "status": "INACTIVE"}},
     [("company", "Uno SL", None), ("status", "Cliente", "Inactivo")], "update_client"),
    ({"kind": "ticket", "id": "k1", "list": {"cliente": "c1"}, "changes": {"status": "RESOLVED", "category": "SUPPORT"}},
     [("status", "Abierto", "Resuelto"), ("category", "Error", "Soporte")], "update_ticket"),
])
def test_antes_y_despues_de_cada_cambio(setup, fake, body, rows, tool):
    client, settings = setup
    shown = preview(client, body)
    assert shown.status_code == 200, shown.text
    assert [(r["field"], r["before"], r["after"]) for r in shown.json()["rows"]] == rows, "solo lo que cambia"
    assert fake.writes() == [], "la vista previa no escribe"
    done = confirm(client, shown.json()["token"])
    assert done.status_code == 200 and done.json()["done"] is True, done.text
    sent = fake.writes()
    assert len(sent) == 1 and sent[0]["tool"] == tool
    assert set(sent[0]["arguments"]) - {"taskId", "projectId", "clientId", "ticketId"} == {r[0] for r in rows}
    c = connect(settings.data_dir / DB_NAME)
    try:
        logged = c.execute("SELECT action, detail FROM action_log ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        c.close()
    assert logged[0] == "cambiar_en_crmdev" and sorted(json.loads(logged[1])["fields"]) == sorted(r[0] for r in rows)
    for value in ("Maquetar portada", "Resuelto", "INACTIVE"):
        assert value not in logged[1], "solo los nombres de los campos"


def test_vaciar_avisa_y_un_cambio_vacio_da_422(setup, fake):
    client, _ = setup
    emptied = preview(client, {"kind": "tarea", "id": "t1", "changes": {"description": ""}})
    assert emptied.status_code == 200 and emptied.json()["rows"][0]["emptied"] is True and emptied.json()["warnings"]
    for body in ({"kind": "tarea", "id": "t1", "changes": {"status": "TODO"}}, {"kind": "tarea", "id": "t1", "changes": {}},
                 {"kind": "proyecto", "id": "p1", "changes": {"name": "Web Uno "}}):
        answer = preview(client, body)
        assert answer.status_code == 422 and answer.json()["status"] == "invalid", body


@pytest.mark.parametrize("body", [
    {"kind": "cliente", "id": "c1", "changes": {"notes": "x"}}, {"kind": "proyecto", "id": "p1", "changes": {"description": "x"}},
    {"kind": "cliente", "id": "c1", "changes": {"email": ""}}, {"kind": "tarea", "id": "t1", "changes": {"title": ""}},
    {"kind": "tarea", "id": "t1", "changes": {"status": "BORRADO"}}, {"kind": "ticket", "id": "k1", "changes": {"category": "OTRA"}},
    {"kind": "proyecto", "id": "p1", "changes": {"progress": 101}}, {"kind": "proyecto", "id": "p1", "changes": {"progress": True}},
    {"kind": "tarea", "id": "t1", "changes": {"title": "x" * 301}}, {"kind": "tarea", "id": "../t1", "changes": {"title": "x"}},
    {"kind": "tarea", "id": "t1", "list": {"cliente": "c1"}, "changes": {"title": "x"}},
    {"kind": "tarea-nueva", "values": {"title": "x", "dueDate": "2026-02-30"}}, {"kind": "cliente-nuevo", "values": {"name": "X", "email": "no"}},
])
def test_campos_no_permitidos_o_invalidos_sin_peticiones(setup, fake, body):
    client, _ = setup
    answer = preview(client, body)
    assert answer.status_code == 422, (body, answer.text)
    assert fake.writes() == []


def test_nunca_se_envian_notas_ni_descripcion_del_proyecto(setup, fake):
    client, _ = setup
    for body in ({"kind": "cliente", "id": "c1", "changes": {"name": "Cliente 1", "email": "hola@uno.example"}},
                 {"kind": "proyecto", "id": "p1", "changes": {"name": "Web 1"}}):
        assert confirm(client, preview(client, body).json()["token"]).status_code == 200
    sent = {b["tool"]: b["arguments"] for b in fake.writes()}
    assert "notes" not in sent["update_client"] and "description" not in sent["update_project"]
    assert sent["update_client"] == {"clientId": "c1", "name": "Cliente 1", "email": "hola@uno.example"}


def test_texto_actual_mas_largo_de_lo_que_se_ve_no_se_edita(setup, fake):
    client, _ = setup
    fake.rows["list_tasks"][0]["description"] = "d" * 4001
    answer = preview(client, {"kind": "tarea", "id": "t1", "changes": {"description": "corto"}})
    assert answer.status_code == 422 and "CRMDev" in answer.json()["error"]


def test_si_cambia_en_crmdev_entre_la_vista_previa_y_confirmar_no_se_envia(setup, fake):
    client, _ = setup
    token = preview(client, {"kind": "tarea", "id": "t1", "changes": {"status": "DONE"}}).json()["token"]
    fake.rows["list_tasks"][0]["status"] = "CANCELLED"  # someone else, in CRMDev
    stale = confirm(client, token)
    assert stale.status_code == 409 and stale.json()["status"] == "conflict"
    assert stale.json()["current"] == [{"field": "status", "label": "Estado", "value": "Cancelada"}]
    assert fake.writes() == [] and confirm(client, token).status_code == 410, "la ficha queda gastada"


def test_si_ya_esta_asi_no_se_vuelve_a_enviar(setup, fake):
    client, _ = setup
    token = preview(client, {"kind": "ticket", "id": "k1", "changes": {"status": "CLOSED"}}).json()["token"]
    fake.rows["list_tickets"][0]["status"] = "CLOSED"
    assert confirm(client, token).json()["done"] is True and fake.writes() == []


def test_doble_confirmacion_una_sola_peticion(setup, fake):
    client, _ = setup
    token = preview(client, {"kind": "tarea", "id": "t1", "changes": {"priority": "URGENT"}}).json()["token"]
    first, second = confirm(client, token), confirm(client, token)
    assert first.status_code == 200 and "repeated" not in first.json()
    assert second.status_code == 200 and second.json()["repeated"] is True
    assert [b["tool"] for b in fake.writes()] == ["update_task"]


def test_ficha_caducada_410(setup, fake, monkeypatch):
    client, _ = setup
    token = preview(client, {"kind": "tarea", "id": "t1", "changes": {"priority": "URGENT"}}).json()["token"]
    later = confirmed_change._now() + 3600
    monkeypatch.setattr(confirmed_change, "_now", lambda: later)
    assert confirm(client, token).status_code == 410 and fake.writes() == []


def test_tarea_nueva_con_proyecto_y_asignada(setup, fake):
    client, settings = setup
    shown = preview(client, {"kind": "tarea-nueva", "values": {"title": "Revisar SEO", "projectId": "p1", "assigneeId": "u1", "priority": "HIGH",
                                                               "dueDate": "2026-12-01", "status": ""}})
    assert shown.status_code == 200, shown.text
    assert {r["field"]: r["after"] for r in shown.json()["rows"]} == {"title": "Revisar SEO", "projectId": "Web Uno", "assigneeId": "Ana",
                                                                      "priority": "Alta", "dueDate": "01/12/2026"}
    assert confirm(client, shown.json()["token"]).status_code == 200
    assert fake.writes() == [{"tool": "create_task", "arguments": {"title": "Revisar SEO", "projectId": "p1", "assigneeId": "u1", "priority": "HIGH",
                                                                   "dueDate": "2026-12-01"}}]
    c = connect(settings.data_dir / DB_NAME)
    try:
        assert c.execute("SELECT action FROM action_log ORDER BY id DESC LIMIT 1").fetchone()[0] == "crear_en_crmdev"
    finally:
        c.close()
    unknown = preview(client, {"kind": "tarea-nueva", "values": {"title": "x", "projectId": "p9"}})
    assert unknown.status_code == 422


def test_cliente_nuevo_duplicado_da_409_con_su_id(setup, fake):
    client, _ = setup
    for values in ({"name": "  cliente   UNO "}, {"name": "Otro", "email": "INFO@cliente.example"}):
        answer = preview(client, {"kind": "cliente-nuevo", "values": values})
        assert answer.status_code == 409 and answer.json()["status"] == "exists" and answer.json()["crmdevId"] == "c1", values
    shown = preview(client, {"kind": "cliente-nuevo", "values": {"name": "Cliente Dos", "phone": "600 000 000"}})
    assert shown.status_code == 200
    fake.rows["list_clients"].insert(0, {"id": "c2", "name": "Cliente Dos", "email": None, "company": None, "status": "LEAD"})
    late = confirm(client, shown.json()["token"])
    assert late.status_code == 409 and late.json()["crmdevId"] == "c2" and fake.writes() == [], "apareció mientras tanto: no se duplica"


def test_tras_un_cambio_se_vacia_la_cache_de_esa_lista(setup, fake):
    client, _ = setup
    assert client.get("/crmdev/views/tareas", headers=HEADERS).json()["items"][0]["status"] == "TODO"
    token = preview(client, {"kind": "tarea", "id": "t1", "changes": {"status": "DONE"}}).json()["token"]
    assert confirm(client, token).status_code == 200
    reads = fake.tools().count("list_tasks")
    assert client.get("/crmdev/views/tareas", headers=HEADERS).json()["items"][0]["status"] == "DONE"
    assert fake.tools().count("list_tasks") == reads + 1, "se vuelve a leer, no sale de la caché"


def test_crmdev_ocupado_permite_volver_a_pulsar_y_un_alta_sin_respuesta_no_se_repite(setup, fake):
    client, _ = setup
    token = preview(client, {"kind": "tarea", "id": "t1", "changes": {"status": "DONE"}}).json()["token"]
    fake.fail_write = httpx.Response(429, json={"error": "Too many requests", "retryAfter": 1})
    busy = confirm(client, token)
    assert busy.status_code == 429 and busy.json()["status"] == "busy"
    crmdev_api.clear_cache()  # the wait CRMDev asked for is over
    fake.fail_write = None
    assert confirm(client, token).status_code == 200
    created = preview(client, {"kind": "tarea-nueva", "values": {"title": "Una"}}).json()["token"]
    fake.fail_write = httpx.Response(500, json={"error": "Internal server error"})
    lost = confirm(client, created)
    assert lost.status_code == 502 and lost.json()["status"] == "unknown"
    fake.fail_write = None
    again = confirm(client, created)
    assert again.status_code == 409 and again.json()["status"] == "unknown"
    assert [b["tool"] for b in fake.writes()].count("create_task") == 1


def test_modulo_apagado_404_y_sin_conexion_409(setup, fake):
    client, settings = setup
    token = preview(client, {"kind": "tarea", "id": "t1", "changes": {"status": "DONE"}}).json()["token"]
    c = connect(settings.data_dir / DB_NAME)
    try:
        modules.save(c, {"crmdev": False})
    finally:
        c.close()
    before = len(fake.seen)
    assert preview(client, {"kind": "tarea", "id": "t1", "changes": {"status": "DONE"}}).status_code == 404
    assert confirm(client, token).status_code == 404 and len(fake.seen) == before
    assert client.delete("/connectors/crmdev", headers=HEADERS).status_code in (200, 204)
    c = connect(settings.data_dir / DB_NAME)
    try:
        modules.save(c, {"crmdev": True})
    finally:
        c.close()
    answer = preview(client, {"kind": "tarea", "id": "t1", "changes": {"status": "DONE"}})
    assert answer.status_code == 409 and answer.json()["status"] == "not_connected" and len(fake.seen) == before


def test_ni_la_clave_ni_la_direccion_en_las_respuestas(setup, fake):
    client, _ = setup
    fake.fail_write = httpx.Response(400, json={"error": f"Bad {KEY}"})
    token = preview(client, {"kind": "tarea", "id": "t1", "changes": {"status": "DONE"}}).json()["token"]
    answer = confirm(client, token)
    assert answer.status_code == 422 and KEY not in answer.text and URL not in answer.text


def test_watson_no_tiene_herramientas_de_crmdev():
    source = Path(brain_tools.__file__).read_text(encoding="utf-8")
    assert "crmdev" not in source.lower()
    assert not {spec["name"] for spec in brain_tools.SPECS if "crmdev" in spec["name"]}
