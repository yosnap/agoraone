"""The «CRMDev» routes and its connector: saving and testing the connection without ever answering or storing the key,
the module following its connection, the views read through the closed list with the cache, a module off answering
404 without asking anything, forgetting CRMDev leaving Central's key alone, and hostile text returned as plain text."""

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import central_api, crmdev_api, modules
from agora_core.db import DB_NAME, connect
from test_assistant import MemorySecrets
from test_central_api import HEADERS, KEY as CENTRAL_KEY, URL as CENTRAL_URL, FakeCentral, app_with
from test_crmdev_api import HOSTILE, KEY, URL, FakeCrmdev


@pytest.fixture(autouse=True)
def empty_cache():
    crmdev_api.clear_cache()
    yield
    crmdev_api.clear_cache()


@pytest.fixture
def fake(monkeypatch):
    found = FakeCrmdev()
    monkeypatch.setattr(crmdev_api, "TRANSPORT", httpx.MockTransport(found))
    return found


def connected(client) -> None:
    saved = client.put("/connectors/crmdev", json={"url": URL, "key": KEY}, headers=HEADERS)
    assert saved.status_code == 200, saved.text


def test_conectar_probar_y_el_modulo_sigue_a_la_conexion(tmp_path, fake):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        entry = client.get("/connectors/crmdev", headers=HEADERS).json()
        assert entry["kind"] == "web_api" and entry["modules"] == {"crmdev": False} and entry["views"] == ["crmdev"]
        assert entry["window"] == "crmdev" and entry["scopes"] == ["organizacion"] and entry["hint"] == "https://crm.example.com"
        assert client.get("/crmdev/views/proyectos", headers=HEADERS).status_code == 404, "sin conexión, el módulo está apagado"
        connected(client)
        entry = client.get("/connectors/crmdev", headers=HEADERS).json()
        assert entry["state"]["status"] == "saved" and entry["state"]["configured"] == {"url": URL, "hasKey": True}
        assert entry["modules"] == {"crmdev": True}, "con una dirección guardada se enciende"
        tested = client.post("/connectors/crmdev/test", headers=HEADERS)
        assert tested.status_code == 200 and tested.json()["tools"] == sorted(crmdev_api.READ_TOOLS - {"list_tickets"})
        assert tested.json()["unverified"] == ["list_tickets"]
        for answer in (entry, tested.json(), client.get("/connectors", headers=HEADERS).json()):
            assert KEY not in str(answer)
        refused = client.post("/connectors/crmdev/test", json={"key": "crm_" + "f" * 48}, headers=HEADERS)
        assert refused.status_code == 502 and refused.json()["status"] == "auth" and refused.json()["error"] == crmdev_api.REVOKED
        assert client.put("/connectors/crmdev", json={"url": URL, "key": "cp_" + "a" * 43}, headers=HEADERS).status_code == 422
        assert client.put("/connectors/crmdev", json={"url": "http://crm.example.com", "key": KEY}, headers=HEADERS).status_code == 422
    assert secrets.get(crmdev_api.SECRET) == KEY and secrets.get(central_api.SECRET) is None
    c = connect(settings.data_dir / DB_NAME)
    try:
        dumped = "\n".join(str(tuple(row)) for row in c.execute("SELECT * FROM setting"))
        assert KEY not in dumped and URL in dumped, "la clave nunca va a la base de datos"
    finally:
        c.close()


def test_la_clave_guardada_no_viaja_a_otro_origen(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        before = len(fake.seen)
        assert client.put("/connectors/crmdev", json={"url": "https://crm.example.net"}, headers=HEADERS).status_code == 422
        assert client.post("/connectors/crmdev/test", json={"url": "https://crm.example.net"}, headers=HEADERS).status_code == 422
        assert len(fake.seen) == before


def test_vistas_y_cache(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        first = client.get("/crmdev/views/tareas", headers=HEADERS)
        again = client.get("/crmdev/views/tareas", headers=HEADERS)
        assert first.status_code == 200 and first.json() == again.json()
        assert fake.tools() == ["list_tasks"], "dos lecturas seguidas, una sola petición"
        body = first.json()
        assert body["limit"] == 100 and body["more"] is False and body["order"] == "recientes" and body["items"][0]["assignee"] == {"id": "u1", "name": "Ana"}
        assert "ana@example.com" not in first.text
        connected(client)  # saving the connection empties the cache
        client.get("/crmdev/views/tareas", headers=HEADERS)
        assert fake.tools() == ["list_tasks", "list_tasks"]
        assert client.get("/crmdev/views/tareas?estado=TODO&proyecto=p1", headers=HEADERS).status_code == 200
        assert crmdev_api.json.loads(fake.seen[-1].content)["arguments"] == {"status": "TODO", "projectId": "p1", "limit": 100}
        for view in ("proyectos", "clientes", "miembros"):
            assert client.get(f"/crmdev/views/{view}", headers=HEADERS).status_code == 200, view
        clients = client.get("/crmdev/views/clientes", headers=HEADERS).json()["items"]
        assert clients == [{"id": "c1", "name": "Cliente Uno", "company": "Uno SL", "status": "CUSTOMER"}], "sin correo en la lista"
        hours = client.get("/crmdev/proyectos/p1/horas", headers=HEADERS)
        assert hours.status_code == 200 and hours.json()["total"] == "2h 30m"


def test_texto_hostil_es_solo_texto(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        tickets = client.get("/crmdev/views/tickets", headers=HEADERS)
        assert tickets.status_code == 200 and tickets.json()["items"][0]["title"] == HOSTILE
        assert "luis@example.com" not in tickets.text and "guestEmail" not in tickets.text
        assert fake.tools() == ["list_tickets"], "leerlo no dispara nada más"
        c = connect(settings.data_dir / DB_NAME)
        try:
            dumped = "\n".join(str(tuple(row)) for table in ("setting",) for row in c.execute(f"SELECT * FROM {table}"))
            assert "onerror" not in dumped, "lo leído no se guarda"
        finally:
            c.close()


def test_filtros_y_vistas_que_no_existen(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        assert client.get("/crmdev/views/borrar", headers=HEADERS).status_code == 404
        for path in ("/crmdev/views/proyectos?proyecto=p1", "/crmdev/views/tareas?estado=BORRADO", "/crmdev/views/tickets?cliente=../x",
                     "/crmdev/views/clientes?limit=5", "/crmdev/views/tareas?estado=TODO&estado=DONE", "/crmdev/proyectos/a%2Fb/horas",
                     "/crmdev/proyectos/p1/horas?x=1"):
            assert client.get(path, headers=HEADERS).status_code == 422, path
        assert fake.tools() == []


def test_sin_clave_409(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        client.delete("/connectors/crmdev", headers=HEADERS)
        answer = client.get("/crmdev/views/proyectos", headers=HEADERS)
        assert answer.status_code == 409 and answer.json() == {"error": "Conecta CRMDev en Conectores › CRMDev.", "status": "not_connected"}


def test_un_429_es_busy(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(crmdev_api, "TRANSPORT", httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(429, json={"retryAfter": 10})))
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        answer = client.get("/crmdev/views/proyectos", headers=HEADERS)
        assert answer.status_code == 429 and answer.json() == {"error": crmdev_api.BUSY, "status": "busy"} and len(seen) == 1


def test_modulo_apagado_404_sin_peticiones(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        client.put("/modules", json={"modules": {"crmdev": False}}, headers=HEADERS)
        for path in ("/crmdev/views/proyectos", "/crmdev/views/tareas", "/crmdev/proyectos/p1/horas"):
            answer = client.get(path, headers=HEADERS)
            assert answer.status_code == 404 and answer.json()["status"] == "off", path
        assert fake.seen == []
        assert client.post("/connectors/crmdev/test", headers=HEADERS).status_code == 200, "conectar no depende del módulo"
        c = connect(settings.data_dir / DB_NAME)
        try:
            assert modules.state(c)["crmdev"] is False, "lo que pone el usuario manda sobre la conexión"
        finally:
            c.close()


def test_olvidar_crmdev_no_toca_central(tmp_path, fake, monkeypatch):
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(FakeCentral()))
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/connectors/central", json={"url": CENTRAL_URL, "key": CENTRAL_KEY}, headers=HEADERS).status_code == 200
        connected(client)
        client.get("/crmdev/views/proyectos", headers=HEADERS)
        gone = client.delete("/connectors/crmdev", headers=HEADERS)
        assert gone.status_code == 200 and gone.json()["state"]["configured"] == {"url": URL, "hasKey": False}
        assert secrets.get(central_api.SECRET) == CENTRAL_KEY and secrets.get(crmdev_api.SECRET) is None
        assert crmdev_api._cache == {}, "olvidar vacía la caché"
        assert client.get("/connectors/central", headers=HEADERS).json()["state"]["status"] == "saved"


def test_miembros_son_los_primeros_y_tickets_apagados_lo_dicen(tmp_path, fake, monkeypatch):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        assert client.get("/crmdev/views/miembros", headers=HEADERS).json()["order"] == "primeros", "CRMDev los ordena por antigüedad"
        monkeypatch.setattr(crmdev_api, "TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(403, json={"error": "MODULE_DISABLED"})))
        off = client.get("/crmdev/views/tickets", headers=HEADERS)
        assert off.status_code == 403 and off.json() == {"error": crmdev_api.TICKETS_OFF, "status": "forbidden"}


def test_probar_con_429_responde_429(tmp_path, monkeypatch):
    monkeypatch.setattr(crmdev_api, "TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(429, json={"retryAfter": 10})))
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        tested = client.post("/connectors/crmdev/test", headers=HEADERS)
        assert tested.status_code == 429 and tested.json()["status"] == "busy"


def test_ficha_de_cliente_con_su_correo_desde_la_misma_lista(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client)
        listed = client.get("/crmdev/views/clientes", headers=HEADERS)
        assert "info@cliente.example" not in listed.text, "la lista nunca lleva el correo"
        record = client.get("/crmdev/clientes/c1", headers=HEADERS)
        assert record.status_code == 200
        assert record.json() == {"id": "c1", "name": "Cliente Uno", "company": "Uno SL", "status": "CUSTOMER", "email": "info@cliente.example"}
        assert fake.tools() == ["list_clients"], "la ficha usa la lista ya leída, sin otra petición"
        missing = client.get("/crmdev/clientes/c9", headers=HEADERS)
        assert missing.status_code == 404 and missing.json()["status"] == "not_found"
        for path in ("/crmdev/clientes/a%2Fb", "/crmdev/clientes/c1?x=1", "/crmdev/clientes/" + "a" * 65):
            assert client.get(path, headers=HEADERS).status_code == 422, path
        assert fake.tools() == ["list_clients"]
        client.put("/modules", json={"modules": {"crmdev": False}}, headers=HEADERS)
        off = client.get("/crmdev/clientes/c1", headers=HEADERS)
        assert off.status_code == 404 and off.json()["status"] == "off"
