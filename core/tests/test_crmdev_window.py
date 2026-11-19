"""CRMDev's own window: only pages of a closed list of CRMDev's Spanish routes on the saved CRMDev address, the order
collected by the desktop app at /internal, the system's browser when there is no desktop app, 404 with the module off
(and the window told to close) and 409 without an address. AgoraOne's key never appears in what the window receives,
and Central's window stays apart."""

import pytest
from fastapi.testclient import TestClient

from agora_core import crmdev_api, routes_crmdev_window, web_api
from agora_core.db import DB_NAME, connect
from test_assistant import MemorySecrets
from test_central_api import HEADERS, app_with
from test_crmdev_api import KEY, URL


@pytest.fixture
def opened(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr("webbrowser.open", lambda url, new=0: seen.append(url) or True)
    return seen


def save_url(client, url: str | None) -> None:
    connection = connect(client.database)
    try:
        web_api.save_url(crmdev_api.SPEC, connection, url)
    finally:
        connection.close()


@pytest.fixture
def client(tmp_path):
    secrets = MemorySecrets()
    web_api.write_key(crmdev_api.SPEC, secrets, KEY)
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.database = settings.data_dir / DB_NAME
        save_url(client, URL)
        client.put("/modules", json={"modules": {"crmdev": True}}, headers=HEADERS)
        yield client


def desktop(client) -> dict:
    """What the desktop app collects, after saying it is there (a first ask only learns the count)."""
    return client.get("/internal/crmdev/window/next", params={"after": -1}, headers=HEADERS).json()


def test_lista_cerrada_de_paginas():
    route_of = routes_crmdev_window.route_of
    for page in ("panel", "proyectos", "tareas", "clientes", "soporte"):
        assert route_of(page) == (f"es/{page}", "crmdev")
    assert route_of("/proyectos/p_1-A/") == ("es/proyectos/p_1-A", "crmdev")
    assert route_of("clientes/cmabc123") == ("es/clientes/cmabc123", "crmdev")
    assert route_of("tickets/k1") == ("es/soporte/tickets/k1", "crmdev"), "un ticket vive bajo soporte"
    for wrong in ("", "acceso", "configuracion/claves-api", "api/mcp/rest", "proyectos//x", "proyectos/../configuracion", "proyectos/a/b",
                  "proyectos/a%2Fb", "proyectos/x y", "tareas/t1", "soporte/tickets/k1", "es/panel", "panel?x=1", "panel#x",
                  "//evil.example", "https://evil.example", "proyectos/" + "a" * 65, None, 3, "a" * 200):
        assert route_of(wrong) is None, wrong


def test_orden_para_la_app_de_escritorio(client, opened):
    assert desktop(client) == {"seq": 0, "commands": [], "allowed": True, "url": URL}
    assert client.post("/crmdev/window", json={"ruta": "proyectos/p1"}, headers=HEADERS).status_code == 200
    client.post("/crmdev/window", json={"ruta": "tickets/k1"}, headers=HEADERS)
    got = client.get("/internal/crmdev/window/next", params={"after": 0}, headers=HEADERS).json()
    assert [c["url"] for c in got["commands"]] == [f"{URL}/es/proyectos/p1", f"{URL}/es/soporte/tickets/k1"]
    assert all(c["action"] == "open" for c in got["commands"])
    assert KEY not in str(got)
    assert opened == []


def test_ruta_fuera_de_la_lista_422_sin_orden(client):
    desktop(client)
    for wrong in ({"ruta": "acceso"}, {"ruta": "proyectos/../configuracion"}, {"ruta": "clientes/a/b"}, {"ruta": "https://evil.example"}, {},
                  {"ruta": 5}):
        answer = client.post("/crmdev/window", json=wrong, headers=HEADERS)
        assert answer.status_code == 422 and answer.json()["status"] == "invalid", wrong
        assert client.post("/crmdev/window/browser", json=wrong, headers=HEADERS).status_code == 422
    assert desktop(client)["seq"] == 0


def test_sin_app_de_escritorio_ofrece_el_navegador(client, opened):
    answer = client.post("/crmdev/window", json={"ruta": "panel"}, headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "no_window"
    assert "navegador" in answer.json()["error"]
    assert client.post("/crmdev/window/browser", json={"ruta": "clientes/c1"}, headers=HEADERS).json() == {"done": True}
    assert opened == [f"{URL}/es/clientes/c1"]


def test_sin_direccion_guardada_409(client):
    desktop(client)
    save_url(client, None)
    answer = client.post("/crmdev/window", json={"ruta": "panel"}, headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "not_connected"
    assert client.get("/internal/crmdev/window/next", params={"after": 0}, headers=HEADERS).json()["url"] is None


def test_modulo_apagado_404_y_la_ventana_se_cierra(client, opened):
    desktop(client)
    client.put("/modules", json={"modules": {"crmdev": False}}, headers=HEADERS)
    for path in ("/crmdev/window", "/crmdev/window/browser"):
        answer = client.post(path, json={"ruta": "panel"}, headers=HEADERS)
        assert answer.status_code == 404 and answer.json()["status"] == "off", path
    assert client.post("/crmdev/window/external", json={"url": "https://example.com/"}, headers=HEADERS).status_code == 404
    # Closing and checking are always allowed; the desktop app is told the window may not stay.
    assert client.post("/crmdev/window/close", headers=HEADERS).json() == {"done": True}
    got = client.get("/internal/crmdev/window/next", params={"after": 0}, headers=HEADERS).json()
    assert [c["action"] for c in got["commands"]] == ["close"] and got["allowed"] is False
    assert opened == []


def test_enlaces_externos_solo_web(client, opened):
    assert client.post("/crmdev/window/external", json={"url": "https://github.com/login"}, headers=HEADERS).json() == {"done": True}
    for wrong in ("javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com/"):
        assert client.post("/crmdev/window/external", json={"url": wrong}, headers=HEADERS).status_code == 422, wrong
    assert opened == ["https://github.com/login"]


def test_la_ventana_no_abre_el_host_de_agoraone(client, opened):
    desktop(client)
    for address in ("http://127.0.0.1:3000", "http://[::1]:3000"):
        save_url(client, address)
        answer = client.post("/crmdev/window", json={"ruta": "panel"}, headers=HEADERS)
        assert answer.status_code == 422 and answer.json()["status"] == "loopback_ip", address
    assert desktop(client)["seq"] == 0, "ninguna orden para la ventana"
    assert client.post("/crmdev/window/browser", json={"ruta": "panel"}, headers=HEADERS).json() == {"done": True}
    assert opened == ["http://[::1]:3000/es/panel"]


def test_cada_ventana_con_su_cola(client):
    """CRMDev's orders never reach Central's window, nor the other way round."""
    desktop(client)
    client.get("/internal/central/window/next", params={"after": -1}, headers=HEADERS)
    client.post("/crmdev/window", json={"ruta": "panel"}, headers=HEADERS)
    client.post("/central/window/close", headers=HEADERS)
    crmdev = client.get("/internal/crmdev/window/next", params={"after": 0}, headers=HEADERS).json()["commands"]
    central = client.get("/internal/central/window/next", params={"after": 0}, headers=HEADERS).json()["commands"]
    assert [c["action"] for c in crmdev] == ["open"]
    assert [c["action"] for c in central] == ["close"]
