"""Central's own window: only pages of a closed list (ids with the shape of a cuid) of the saved Central address, the
order collected by the desktop app at /internal, the system's browser when there is no desktop app, only https for
links to other sites, and 404 with the module off (a quote's page follows «Presupuestos»). AgoraOne's key never
appears in what the window receives."""

import pytest
from fastapi.testclient import TestClient

from agora_core import central_api, routes_central_window
from agora_core.db import DB_NAME, connect
from test_assistant import MemorySecrets
from test_central_api import HEADERS, KEY, URL, app_with

C1 = "c" + "1" * 24


@pytest.fixture
def opened(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(routes_central_window.webbrowser, "open", lambda url, new=0: seen.append(url) or True)
    return seen


@pytest.fixture
def client(tmp_path):
    secrets = MemorySecrets()
    central_api.write_key(secrets, KEY)
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.database = settings.data_dir / DB_NAME
        save_url(client, URL)
        yield client


def save_url(client, url: str | None) -> None:
    connection = connect(client.database)
    try:
        central_api.save_url(connection, url)
    finally:
        connection.close()


def desktop(client) -> dict:
    """What the desktop app collects, after saying it is there (a first ask only learns the count)."""
    return client.get("/internal/central/window/next", params={"after": -1}, headers=HEADERS).json()


def test_lista_cerrada_de_paginas():
    assert routes_central_window.route_of("ajustes") == ("ajustes", "central")
    assert routes_central_window.route_of("/") == ("", "central")
    assert routes_central_window.route_of("") == ("", "central")
    assert routes_central_window.route_of(f"clientes/{C1}") == (f"clientes/{C1}", "central")
    assert routes_central_window.route_of(f"/presupuestos/{C1}/") == (f"presupuestos/{C1}", "presupuestos")
    for wrong in ("login", "api/v1/clientes", "clientes", f"clientes/{C1}/editar", "clientes/../ajustes", "clientes/ABC", "//evil.example",
                  "https://evil.example", "ajustes?x=1", "ajustes#x", f"servidores/{C1}", None, 3, "a" * 100):
        assert routes_central_window.route_of(wrong) is None, wrong


def test_solo_https_hacia_otros_sitios():
    good = "https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fcentral.example.com"
    assert routes_central_window.external_url(good) == good
    for wrong in ("http://example.com", "javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com/", "https://@example.com/",
                  "https://", "https://exa mple.com", "https://example.com/é", "https://ex_ample.com/", "https://example.com:99999/",
                  "data:text/html,x", "https://example.com/" + "a" * 2001, None, 1):
        assert routes_central_window.external_url(wrong) is None, wrong


def test_orden_para_la_app_de_escritorio(client, opened):
    assert desktop(client) == {"seq": 0, "commands": []}
    answer = client.post("/central/window", json={"ruta": "ajustes"}, headers=HEADERS)
    assert answer.status_code == 200
    got = client.get("/internal/central/window/next", params={"after": 0}, headers=HEADERS).json()
    assert got["commands"] == [{"seq": 1, "action": "open", "url": f"{URL}/ajustes"}]
    assert KEY not in str(got)
    client.post("/central/window", json={"ruta": f"proyectos/{C1}"}, headers=HEADERS)
    client.post("/central/window", json={"ruta": "/"}, headers=HEADERS)
    later = client.get("/internal/central/window/next", params={"after": 1}, headers=HEADERS).json()["commands"]
    assert [c["url"] for c in later] == [f"{URL}/proyectos/{C1}", f"{URL}/"]
    assert opened == []


def test_ruta_fuera_de_la_lista_422(client):
    desktop(client)
    for wrong in ({"ruta": "login"}, {"ruta": "clientes/x"}, {"ruta": f"clientes/{C1}/../../x"}, {"ruta": "https://evil.example"}, {}, {"ruta": 5}):
        answer = client.post("/central/window", json=wrong, headers=HEADERS)
        assert answer.status_code == 422 and answer.json()["status"] == "invalid", wrong
        assert client.post("/central/window/browser", json=wrong, headers=HEADERS).status_code == 422


def test_sin_app_de_escritorio_ofrece_el_navegador(client, opened):
    answer = client.post("/central/window", json={"ruta": "ajustes"}, headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "no_window"
    assert client.post("/central/window/browser", json={"ruta": f"clientes/{C1}"}, headers=HEADERS).json() == {"done": True}
    assert opened == [f"{URL}/clientes/{C1}"]


def test_enlaces_externos_solo_https(client, opened):
    assert client.post("/central/window/external", json={"url": "https://mail.google.com/mail/u/0/"}, headers=HEADERS).json() == {"done": True}
    for wrong in ("http://example.com", "javascript:alert(1)", "file:///etc/passwd", "about:blank"):
        answer = client.post("/central/window/external", json={"url": wrong}, headers=HEADERS)
        assert answer.status_code == 422, wrong
    assert opened == ["https://mail.google.com/mail/u/0/"]


def test_navegador_que_no_abre_da_502(client, monkeypatch):
    monkeypatch.setattr(routes_central_window.webbrowser, "open", lambda url, new=0: False)
    answer = client.post("/central/window/external", json={"url": "https://example.com/"}, headers=HEADERS)
    assert answer.status_code == 502 and answer.json()["status"] == "error"


def test_sin_direccion_guardada_409(client):
    desktop(client)
    client.put("/modules", json={"modules": {"central": True}}, headers=HEADERS)
    save_url(client, None)
    answer = client.post("/central/window", json={"ruta": "ajustes"}, headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "not_connected"


def test_modulo_apagado_404(client, opened):
    desktop(client)
    client.put("/modules", json={"modules": {"central": False, "presupuestos": True}}, headers=HEADERS)
    for ruta in ("ajustes", "/", f"clientes/{C1}", "login"):
        for path in ("/central/window", "/central/window/browser"):
            answer = client.post(path, json={"ruta": ruta}, headers=HEADERS)
            assert answer.status_code == 404 and answer.json()["status"] == "off", (path, ruta)
    # A quote's page follows «Presupuestos», which works without the «Central» module.
    assert client.post("/central/window", json={"ruta": f"presupuestos/{C1}"}, headers=HEADERS).status_code == 200
    client.put("/modules", json={"modules": {"presupuestos": False}}, headers=HEADERS)
    assert client.post("/central/window", json={"ruta": f"presupuestos/{C1}"}, headers=HEADERS).status_code == 404
    assert client.post("/central/window/external", json={"url": "https://example.com/"}, headers=HEADERS).status_code == 404
    commands = client.get("/internal/central/window/next", params={"after": 0}, headers=HEADERS).json()["commands"]
    assert [c["url"] for c in commands] == [f"{URL}/presupuestos/{C1}"]
    assert opened == []
