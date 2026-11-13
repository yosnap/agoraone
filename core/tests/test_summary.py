import json
import sqlite3
import time

from fastapi.testclient import TestClient

from agora_core import addons
from agora_core.app import SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings
from agora_core.summary import count_words, top

from test_assistant import OWNER, SECRET, SOURCE, MemorySecrets
from test_brain_tools import NOTES, ToolEngine, ref


def test_palabras_sin_vacias_ni_claves():
    counter = count_words(["Proyecto proyecto agentes para del sk-ant-api03xyz token9abc https://web.com ñandú aaaa"])
    assert top(counter) == [{"word": "proyecto", "count": 2}, {"word": "agentes", "count": 1}, {"word": "ñandú", "count": 1}]


def costguard_db(path, now):
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE horas (espacio_id, hora, agente, proveedor, modelo, proyecto_raw, gi, go, cr, cw, turnos)")
    hour = int(now // 3600 * 3600)
    rows = [(1, hour, "claude", "a", "m", "tienda", 100, 50, 10, 0, 2), (1, hour - 3600, "codex", "o", "m", "/ruta/a/tienda", 40, 10, 0, 0, 1),
            (1, hour, "claude", "a", "m", "blog", 5, 5, 0, 0, 1), (1, hour - 40 * 86400, "claude", "a", "m", "viejo", 999, 0, 0, 0, 1)]
    connection.executemany("INSERT INTO horas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    connection.commit()
    connection.close()


def test_costguard_por_proyecto_solo_nombre_y_solo_lectura(tmp_path):
    now = time.time()
    path = tmp_path / "consumo.sqlite"
    costguard_db(path, now)
    before = path.stat().st_mtime_ns
    projects = addons.costguard_projects(path, 24, now)
    assert [(p["project"], p["tokens"], p["turns"]) for p in projects] == [("tienda", 200, 3), ("blog", 10, 1)]
    assert path.stat().st_mtime_ns == before
    assert "viejo" not in {p["project"] for p in addons.costguard_projects(path, 720, now)}, "fuera de la ventana"


def test_resumen_del_nucleo(tmp_path, monkeypatch):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets(), engines=lambda s, k: [ToolEngine()])
    monkeypatch.setattr(addons, "is_costguard_data", lambda path: False)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        assert client.get("/summary").status_code == 401
        notes = [{"ref": ref(n), "title": t, "folder": "", "revision": "r", "modifiedAt": "x", "text": text} for n, (t, text) in enumerate(NOTES)]
        client.post("/internal/index/notes", json={"source": SOURCE, "sourceName": "Vault", "notes": notes}, headers=headers)
        conversation = client.post("/assistant/conversations", headers=headers).json()
        client.post(f"/assistant/conversations/{conversation['id']}/messages", json={"message": "¿Qué congreso tengo?"}, headers=headers)
        summary = client.get("/summary", headers=headers).json()
        assert summary["core"]["uptimeSeconds"] >= 0 and summary["costguard"] == {"available": False}
        watson = summary["watson"]
        assert watson["questions"] == 1 and watson["impact"][0]["sources"] == 1
        assert watson["cited"][0]["title"] == "Viaje" and watson["searches"] == [{"query": "congreso hotel", "count": 1}]
        assert watson["words"][0] == {"word": "congreso", "count": 1}
        every = {w["word"] for w in summary["noteWords"]}
        discreet = {w["word"] for w in client.get("/summary", params={"discreet": "1"}, headers=headers).json()["noteWords"]}
        assert "secreta" in every and "secreta" not in discreet and "facturas" not in discreet, "el modo discreto solo cuenta notas normales"
        logged = json.loads(client.get("/summary", headers=headers).text)["watson"]["searches"]
        assert logged[0]["count"] == 1
