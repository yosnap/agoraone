import socket
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agora_core import addons
from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect, migrate
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

SECRET = "a" * 64


@pytest.fixture(autouse=True)
def no_real_costguard(tmp_path, monkeypatch):
    """The default points at the user's real CostGuard data: tests never touch it."""
    manifest = addons.MANIFESTS["costguard"]
    fake = addons.Manifest(manifest.id, manifest.name, manifest.description, manifest.offers, {"dataPath": str(tmp_path / "sin-costguard.sqlite")})
    monkeypatch.setitem(addons.MANIFESTS, "costguard", fake)


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def fabrica(folder):
    folder.mkdir(parents=True)
    (folder / "pyproject.toml").write_text('[project]\nname = "mi-fabrica"\n')
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
    folder = fabrica(tmp_path / "fabrica")
    assert addons.recognised("fabrica", folder)
    other = tmp_path / "otro"
    other.mkdir()
    (other / "pyproject.toml").write_text('[project]\nname = "otra-cosa"\n')
    assert not addons.recognised("fabrica", other)
    for bad in ({"path": "relativa"}, {"path": str(other)}, {"port": 80}, {"port": "8742"}, {"otro": 1}, {"dataPath": "/x"}):
        with pytest.raises(addons.AddonError):
            addons.save_config(db, "fabrica", bad)
    assert addons.save_config(db, "fabrica", {"path": str(folder)})["port"] == 8742


def test_central_ya_no_es_un_complemento(db):
    """Central is connected only through its web API: no folder, no port and no add-on card."""
    assert "central" not in addons.MANIFESTS and "central" not in addons.ALLOWED
    assert "central" not in {a["id"] for a in addons.describe(db)}
    assert not addons.recognised("central", Path("/"))
    with pytest.raises(addons.AddonError):
        addons.save_config(db, "central", {"port": 3099})


def test_estados(tmp_path, db):
    listed = {a["id"]: a["status"] for a in addons.describe(db)}
    assert listed["fabrica"] == "not_configured"
    folder = fabrica(tmp_path / "fabrica")
    with socket.socket() as free:
        free.bind(("127.0.0.1", 0))
        unused = free.getsockname()[1]
    addons.save_config(db, "fabrica", {"path": str(folder), "port": unused})
    assert {a["id"]: a["status"] for a in addons.describe(db)}["fabrica"] == "detected"
    (folder / "pyproject.toml").unlink()
    assert {a["id"]: a["status"] for a in addons.describe(db)}["fabrica"] == "not_found"


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
        assert {a["id"]: a["status"] for a in addons.describe(db)}["fabrica"] == "responding"
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
        assert client.get("/addons/costguard/usage", headers=headers).status_code == 404
        assert client.put("/addons/costguard", json={"dataPath": "/no/existe.sqlite"}, headers=headers).status_code == 422
        text = tmp_path / "nota.txt"
        text.write_text("no soy una base")
        other = tmp_path / "otra.sqlite"
        sqlite3.connect(other).execute("CREATE TABLE x (a)").connection.commit()
        for bad in (text, other):
            assert client.put("/addons/costguard", json={"dataPath": str(bad)}, headers=headers).status_code == 422
        assert client.get("/addons", headers=headers).status_code == 200, "el registro sigue funcionando"
        assert client.put("/addons/central", json={"port": 3099}, headers=headers).status_code == 422, "Central ya no es un complemento"
        assert client.put("/addons/otro", json={}, headers=headers).status_code == 422
        listed = client.put("/addons/costguard", json={"dataPath": str(data)}, headers=headers).json()["addons"]
        assert {a["id"]: a["status"] for a in listed}["costguard"] == "recording"
        assert client.get("/addons/costguard/usage", headers=headers).json()["turns"] == 4
        forgotten = client.put("/addons/costguard", json={"dataPath": None}, headers=headers).json()["addons"]
        assert {a["id"]: a["status"] for a in forgotten}["costguard"] == "not_found", "vuelve al valor por defecto"


def test_ventana_exacta_de_horas(tmp_path):
    data = tmp_path / "consumo.sqlite"
    now = 1_800_000_000 - 1_800_000_000 % 3600 + 1800  # half past an hour
    costguard_db(data, now)
    connection = sqlite3.connect(data)
    hour = now - now % 3600
    connection.execute("INSERT INTO horas VALUES (1, ?, 'limite', 'a', 'm', 'p', 1, 1, 0, 0, 1)", (hour - 5 * 3600,))
    connection.commit()
    connection.close()
    agents = [a["agent"] for a in addons.costguard_usage(data, 5, now)["agents"]]
    assert "limite" not in agents, "5 horas son 5 cubos: el actual y los 4 anteriores"
    assert addons.costguard_usage(data, 1, now)["turns"] == 3


def test_un_complemento_roto_no_rompe_el_registro(tmp_path, db):
    folder = fabrica(tmp_path / "fabrica")
    addons.save_config(db, "fabrica", {"path": str(folder)})
    (folder / "pyproject.toml").write_bytes(b"\xff\xfe no es texto")
    listed = {a["id"]: a["status"] for a in addons.describe(db)}
    assert listed["fabrica"] == "not_found"


def test_costguard_cerrado_no_deja_archivos(tmp_path):
    data = tmp_path / "consumo.sqlite"
    costguard_db(data, time.time())
    connection = sqlite3.connect(data)
    connection.execute("PRAGMA journal_mode = WAL")
    connection.close()
    before = sorted(p.name for p in tmp_path.iterdir())
    assert addons.is_costguard_data(data)
    addons.costguard_usage(data, 5)
    assert sorted(p.name for p in tmp_path.iterdir()) == before


def test_olvidar_ajustes_y_solo_los_propios(tmp_path, db):
    folder = fabrica(tmp_path / "fabrica")
    addons.save_config(db, "fabrica", {"path": str(folder), "port": 4000})
    with pytest.raises(addons.AddonError):
        addons.save_config(db, "fabrica", {"dataPath": str(tmp_path)})
    forgotten = addons.save_config(db, "fabrica", {"path": None, "port": None})
    assert "path" not in forgotten and forgotten["port"] == 8742
    assert {a["id"]: a["status"] for a in addons.describe(db)}["fabrica"] == "not_configured"
