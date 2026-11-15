"""Trabajos' settings: the central bot is the root profile until the user picks another, by Hermes name."""

from fastapi.testclient import TestClient

from agora_core.app import SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings
from tests.test_fiscal_excel import MemorySecrets

SECRET, OWNER = "a" * 64, "b" * 64


def test_bot_central_por_defecto_y_cambiado(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets())
    headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.get("/jobs/settings", headers=headers).json() == {"central": "default"}
        assert client.put("/jobs/settings", json={"central": "pro"}, headers=headers).json() == {"central": "pro"}
        assert client.get("/jobs/settings", headers=headers).json() == {"central": "pro"}
        for wrong in ["../pro", "Pro Bot", "", "x" * 65]:
            assert client.put("/jobs/settings", json={"central": wrong}, headers=headers).status_code in (400, 422)
        assert client.get("/jobs/settings", headers=headers).json() == {"central": "pro"}


def test_proyectos_de_clientes_con_su_consumo(tmp_path):
    """A Central project gets CostGuard's tokens only when the folder has its same name (accents, case and
    punctuation aside); the rest is listed apart, and nothing else of CostGuard or Central leaves."""
    import json
    import sqlite3
    import time

    from agora_core import central, work_projects
    from agora_core.db import DB_NAME, connect, migrate

    usage = tmp_path / "costguard.db"
    db = sqlite3.connect(usage)
    db.execute("CREATE TABLE horas (espacio_id INTEGER, hora INTEGER, agente TEXT, proveedor TEXT, modelo TEXT, proyecto_raw TEXT, gi INTEGER, go INTEGER, cr INTEGER, cw INTEGER, turnos INTEGER)")
    now = time.time()
    hour = int(now // 3600) * 3600
    rows = [(hour, "/Users/x/Proyectos/Café-Web", 1000, 200, 0, 0, 3), (hour - 3 * 86400, "/Users/x/Proyectos/cafe_web", 500, 100, 0, 0, 1),
            (hour - 10 * 86400, "/Users/x/Proyectos/Tienda Online", 4000, 0, 0, 0, 2), (hour, "/Users/x/Proyectos/otra-cosa", 50, 5, 0, 0, 1)]
    db.executemany("INSERT INTO horas VALUES (1, ?, 'claude', 'anthropic', 'm', ?, ?, ?, ?, ?, ?)", rows)
    db.commit()
    db.close()
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    snapshot = {"clients": [{"name": "Cliente Uno", "company": None, "email": "privado@x.es", "taxId": "B123", "domains": [], "websites": [],
                             "projects": [{"name": "Café Web", "status": "ACTIVE", "phase": "Diseño"}, {"name": "Tienda online", "status": "DONE", "phase": None},
                                          {"name": "Sin carpeta", "status": "ACTIVE", "phase": None}]}],
                "servers": [], "fetchedAt": "2026-11-15T08:00:00Z"}
    connection.execute("INSERT INTO setting (key, value) VALUES (?, ?)", (central.SNAPSHOT_SETTING, json.dumps(snapshot)))
    connection.execute("INSERT INTO setting (key, value) VALUES ('addons.costguard', ?)", (json.dumps({"dataPath": str(usage)}),))
    found = work_projects.projects(connection, now)
    web, shop, none = found["clients"][0]["projects"]
    assert web["usage"]["24h"] == {"tokens": 1200, "turns": 3}
    assert web["usage"]["7d"] == {"tokens": 1800, "turns": 4}, "las dos carpetas con el mismo nombre suman"
    assert shop["usage"]["7d"]["tokens"] == 0 and shop["usage"]["30d"]["tokens"] == 4000
    assert none["usage"] is None, "sin carpeta igual, sin consumo: nunca adivinado"
    assert [u["name"] for u in found["unmatched"]] == ["otra-cosa"]
    assert found["costguard"] is True and found["problem"] is None
    text = json.dumps(found)
    assert "privado@x.es" not in text and "B123" not in text and "/Users/" not in text
    connection.close()
