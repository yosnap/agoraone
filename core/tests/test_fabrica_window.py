"""Mi fábrica's window: only pages of a closed list of `http://127.0.0.1:{port}` with the port of its registered
folder, the order collected by the desktop app at /internal, the system's browser when there is no desktop app, only
web addresses for links to other sites, 404 with the module off, and «Arrancar» only through the fábrica's own
launchd service, without stopping or changing it."""

import json
import subprocess
from contextlib import contextmanager

import pytest
from agora_core import (
    addons,
    fabrica_service,
    modules,
    routes_fabrica_window,
    window_links,
)
from agora_core.db import DB_NAME, connect, migrate
from fastapi.testclient import TestClient
from test_assistant import MemorySecrets
from test_central_api import HEADERS, app_with

PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"


@pytest.fixture
def opened(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(window_links.webbrowser, "open", lambda url, new=0: seen.append(url) or True)
    return seen


@pytest.fixture
def folder(tmp_path):
    found = tmp_path / "mi-fabrica"
    found.mkdir()
    (found / "pyproject.toml").write_text('[project]\nname = "mi-fabrica"\n')
    return found


@pytest.fixture
def client(tmp_path, folder):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.database = settings.data_dir / DB_NAME
        with database(client) as c:
            addons.save_config(c, "fabrica", {"path": str(folder), "port": PORT})
        yield client


@contextmanager
def database(client):
    connection = connect(client.database)
    try:
        yield connection
    finally:
        connection.close()


def desktop(client, after: int = -1) -> dict:
    return client.get("/internal/fabrica/window/next", params={"after": after}, headers=HEADERS).json()


def test_lista_cerrada_de_paginas():
    assert routes_fabrica_window.route_of("corridas") == "corridas"
    assert routes_fabrica_window.route_of("/ajustes/") == "ajustes"
    assert routes_fabrica_window.route_of("") == ""
    assert routes_fabrica_window.route_of("/") == ""
    for wrong in ("entrar", "corridas/x", "corridas/x/archivos/1", "../ajustes", "ajustes?x=1", "//evil.example", "https://evil.example",
                  None, 3, "a" * 50):
        assert routes_fabrica_window.route_of(wrong) is None, wrong


def test_orden_con_la_direccion_y_el_puerto_de_la_fabrica(client, opened):
    assert desktop(client) == {"seq": 0, "commands": [], "allowed": True, "url": BASE}
    assert client.post("/fabrica/window", json={"ruta": "corridas"}, headers=HEADERS).status_code == 200
    client.post("/fabrica/window", json={"ruta": ""}, headers=HEADERS)
    got = desktop(client, 0)["commands"]
    assert got == [{"seq": 1, "action": "open", "url": f"{BASE}/corridas"}, {"seq": 2, "action": "open", "url": f"{BASE}/"}]
    assert opened == []


def test_ruta_fuera_de_la_lista_422(client):
    desktop(client)
    for wrong in ({"ruta": "entrar"}, {"ruta": "corridas/x/archivos/1"}, {"ruta": "https://evil.example"}, {}, {"ruta": 5}):
        answer = client.post("/fabrica/window", json=wrong, headers=HEADERS)
        assert answer.status_code == 422 and answer.json()["status"] == "invalid", wrong
        assert client.post("/fabrica/window/browser", json=wrong, headers=HEADERS).status_code == 422


def test_sin_app_de_escritorio_ofrece_el_navegador(client, opened):
    answer = client.post("/fabrica/window", json={"ruta": "ideas"}, headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "no_window"
    assert client.post("/fabrica/window/browser", json={"ruta": "ideas"}, headers=HEADERS).json() == {"done": True}
    assert opened == [f"{BASE}/ideas"]


def test_enlaces_externos_solo_web(client, opened):
    assert client.post("/fabrica/window/external", json={"url": "https://www.youtube.com/watch?v=x"}, headers=HEADERS).json() == {"done": True}
    for wrong in ("javascript:alert(1)", "https://ana@example.com/", "https://example.com/é", "file:///etc/passwd", "about:blank", None):
        answer = client.post("/fabrica/window/external", json={"url": wrong}, headers=HEADERS)
        assert answer.status_code == 422, wrong
    assert opened == ["https://www.youtube.com/watch?v=x"]


def test_sin_carpeta_409_y_la_app_cierra_la_ventana(client, tmp_path):
    with database(client) as c:
        addons.save_config(c, "fabrica", {"path": None})
        modules.save(c, {"fabrica": True})
    desktop(client)
    answer = client.post("/fabrica/window", json={"ruta": "corridas"}, headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "not_configured"
    assert desktop(client)["url"] is None
    with database(client) as c:
        c.execute("INSERT INTO setting (key, value) VALUES ('addons.fabrica', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                  (json.dumps({"path": str(tmp_path / "otra")}),))
    assert client.post("/fabrica/window", json={"ruta": "corridas"}, headers=HEADERS).json()["status"] == "not_configured", "carpeta errónea"


def test_nunca_un_puerto_de_agoraone(client):
    with database(client) as c:
        addons.save_config(c, "fabrica", {"port": 4317})
    desktop(client)
    answer = client.post("/fabrica/window", json={"ruta": "corridas"}, headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "own_port"
    assert desktop(client)["url"] is None


def test_modulo_apagado_404_salvo_cerrar(client, opened):
    with database(client) as c:
        modules.save(c, {"fabrica": False})
    for path, body in (("/fabrica/window", {"ruta": "corridas"}), ("/fabrica/window/browser", {"ruta": "corridas"}),
                       ("/fabrica/window/external", {"url": "https://example.com/"}), ("/fabrica/start", {})):
        answer = client.post(path, json=body, headers=HEADERS)
        assert answer.status_code == 404 and answer.json()["status"] == "off", path
    assert client.post("/fabrica/window/close", headers=HEADERS).status_code == 200
    seq = desktop(client)["seq"]
    assert client.post("/fabrica/window/check", headers=HEADERS).json() == {"done": True}, "comprobar se acepta para cerrar al momento"
    answer = desktop(client, seq)
    assert answer["commands"][-1]["action"] == "check" and answer["allowed"] is False
    assert opened == []


def test_el_modulo_sigue_a_la_carpeta_mientras_no_se_fije(tmp_path, folder):
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    try:
        assert modules.state(c)["fabrica"] is False, "sin carpeta, apagado"
        addons.save_config(c, "fabrica", {"path": str(folder)})
        assert modules.state(c)["fabrica"] is True, "con la carpeta, encendido"
        modules.save(c, {"fabrica": False})
        assert modules.state(c)["fabrica"] is False, "lo que elige el usuario manda"
    finally:
        c.close()


def test_arrancar_pide_a_launchd_su_servicio_sin_pararlo(client, monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(fabrica_service, "supported", lambda: True)
    monkeypatch.setattr(fabrica_service.subprocess, "run", lambda args, **kw: calls.append(args) or subprocess.CompletedProcess(args, 0))
    assert client.post("/fabrica/start", headers=HEADERS).json() == {"done": True, "running": False}
    assert len(calls) == 1 and calls[0][:2] == ["/bin/launchctl", "kickstart"] and "-k" not in calls[0]
    assert calls[0][2].endswith("/com.sn4p.fabrica") and calls[0][2].startswith("gui/")

    monkeypatch.setattr(fabrica_service.subprocess, "run", lambda args, **kw: subprocess.CompletedProcess(args, 113))
    answer = client.post("/fabrica/start", headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "not_installed"

    monkeypatch.setattr(addons, "status", lambda addon, config: "responding")
    monkeypatch.setattr(fabrica_service.subprocess, "run", lambda *a, **kw: pytest.fail("ya en marcha: no se pide nada"))
    assert client.post("/fabrica/start", headers=HEADERS).json() == {"done": True, "running": True}


def test_arrancar_solo_en_macos(client, monkeypatch):
    monkeypatch.setattr(fabrica_service, "supported", lambda: False)
    monkeypatch.setattr(fabrica_service.subprocess, "run", lambda *a, **kw: pytest.fail("fuera de macOS no se ejecuta nada"))
    answer = client.post("/fabrica/start", headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "unsupported"
