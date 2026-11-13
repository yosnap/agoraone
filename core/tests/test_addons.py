import json
import socket
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

from agora_core import addons
from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect, migrate
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

SECRET = "a" * 64


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def central(folder):
    (folder / "src" / "mcp").mkdir(parents=True)
    (folder / "src" / "mcp" / "server.ts").write_text("// mcp")
    (folder / "package.json").write_text(json.dumps({"name": "central"}))
    return folder


def costguard_db(path, now):
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE horas (espacio_id INTEGER, hora INTEGER, agente TEXT, proveedor TEXT, modelo TEXT, proyecto_raw TEXT, gi INTEGER, go INTEGER, cr INTEGER, cw INTEGER, turnos INTEGER)")
    hour = int(now) - int(now) % 3600
    rows = [(1, hour, "claude", "a", "m", "p", 100, 50, 10, 5, 3), (1, hour - 3600, "codex", "o", "m", "p", 40, 20, 0, 0, 1),
            (1, hour - 10 * 3600, "claude", "a", "m", "p", 999, 999, 0, 0, 9)]
    connection.executemany("INSERT INTO horas VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    connection.commit()
    connection.close()


def test_reconoce_solo_la_carpeta_correcta(tmp_path, db):
    folder = central(tmp_path / "central")
    assert addons.recognised("central", folder)
    other = tmp_path / "otro"
    other.mkdir()
    (other / "package.json").write_text(json.dumps({"name": "central"}))
    assert not addons.recognised("central", other), "hace falta también su servidor MCP"
    for bad in ({"path": "relativa"}, {"path": str(other)}, {"port": 80}, {"port": "3099"}, {"otro": 1}):
        with pytest.raises(addons.AddonError):
            addons.save_config(db, "central", bad)
    assert addons.save_config(db, "central", {"path": str(folder)})["port"] == 3099


def test_estados(tmp_path, db):
    listed = {a["id"]: a["status"] for a in addons.describe(db)}
    assert listed["central"] == "not_configured" and listed["fabrica"] == "not_configured"
    folder = central(tmp_path / "central")
    with socket.socket() as free:
        free.bind(("127.0.0.1", 0))
        unused = free.getsockname()[1]
    addons.save_config(db, "central", {"path": str(folder), "port": unused})
    assert {a["id"]: a["status"] for a in addons.describe(db)}["central"] == "detected"
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        addons.save_config(db, "central", {"port": server.getsockname()[1]})
        assert {a["id"]: a["status"] for a in addons.describe(db)}["central"] == "running"
    (folder / "package.json").unlink()
    assert {a["id"]: a["status"] for a in addons.describe(db)}["central"] == "not_found"


def test_fabrica_en_marcha_si_su_panel_responde(tmp_path, db):
    folder = tmp_path / "fabrica"
    folder.mkdir()
    (folder / "pyproject.toml").write_text('[project]\nname = "mi-fabrica"\n')

    class Health(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200 if self.path == "/salud" else 404)
            self.end_headers()

        def log_message(self, *args):
            pass

    panel = HTTPServer(("127.0.0.1", 0), Health)
    threading.Thread(target=panel.serve_forever, daemon=True).start()
    try:
        addons.save_config(db, "fabrica", {"path": str(folder), "port": panel.server_port})
        assert {a["id"]: a["status"] for a in addons.describe(db)}["fabrica"] == "running"
    finally:
        panel.shutdown()


def test_consumo_de_costguard_en_solo_lectura(tmp_path):
    now = time.time()
    data = tmp_path / "consumo.sqlite"
    costguard_db(data, now)
    before = data.stat().st_mtime_ns
    usage = addons.costguard_usage(data, 5, now)
    assert [a["agent"] for a in usage["agents"]] == ["claude", "codex"], "fuera de la ventana no cuenta"
    assert usage["agents"][0] == {"agent": "claude", "input": 100, "output": 50, "cacheRead": 10, "cacheWrite": 5, "turns": 3}
    assert usage["turns"] == 4
    assert data.stat().st_mtime_ns == before, "no se escribe en la base de CostGuard"


def test_rutas(tmp_path):
    now = time.time()
    data = tmp_path / "consumo.sqlite"
    costguard_db(data, now)
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET}
        assert client.get("/addons/costguard/usage", headers=headers).status_code in (200, 404)
        assert client.put("/addons/costguard", json={"dataPath": "/no/existe.sqlite"}, headers=headers).status_code == 422
        assert client.put("/addons/otro", json={}, headers=headers).status_code == 422
        listed = client.put("/addons/costguard", json={"dataPath": str(data)}, headers=headers).json()["addons"]
        assert {a["id"]: a["status"] for a in listed}["costguard"] == "running"
        assert client.get("/addons/costguard/usage", headers=headers).json()["turns"] == 4
