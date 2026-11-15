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


def test_sin_clave_o_con_nombre_repetido_no_se_asigna(tmp_path):
    """Folders with no Latin letters never feed a project (each stays apart under its name), and a name two
    projects share gets no usage at all."""
    import json
    import sqlite3
    import time

    from agora_core import central, work_projects
    from agora_core.db import DB_NAME, connect, migrate

    usage = tmp_path / "costguard.db"
    db = sqlite3.connect(usage)
    db.execute("CREATE TABLE horas (espacio_id INTEGER, hora INTEGER, agente TEXT, proveedor TEXT, modelo TEXT, proyecto_raw TEXT, gi INTEGER, go INTEGER, cr INTEGER, cw INTEGER, turnos INTEGER)")
    hour = int(time.time() // 3600) * 3600
    db.executemany("INSERT INTO horas VALUES (1, ?, 'claude', 'a', 'm', ?, ?, 0, 0, 0, 1)",
                   [(hour, "/x/Проект", 9000), (hour, "/x/项目", 7000), (hour, "/x/web", 300), (hour, "", 40)])
    db.commit()
    db.close()
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    snapshot = {"clients": [{"name": "A", "projects": [{"name": "🚀", "status": "ACTIVE"}, {"name": "Web", "status": "ACTIVE"}]},
                            {"name": "B", "projects": [{"name": "WEB", "status": "ACTIVE"}, {"name": "Sin proyecto", "status": "ACTIVE"}]}], "servers": []}
    connection.execute("INSERT INTO setting (key, value) VALUES (?, ?)", (central.SNAPSHOT_SETTING, json.dumps(snapshot)))
    connection.execute("INSERT INTO setting (key, value) VALUES ('addons.costguard', ?)", (json.dumps({"dataPath": str(usage)}),))
    found = work_projects.projects(connection)
    rocket, web_a = found["clients"][0]["projects"]
    web_b, nameless = found["clients"][1]["projects"]
    assert rocket["usage"] is None, "un emoji no recibe el consumo de carpetas sin letras latinas"
    assert web_a["usage"] is None and web_b["usage"] is None and web_a["ambiguous"] and web_b["ambiguous"]
    assert nameless["usage"] is None, "el cubo sin nombre de CostGuard no se asocia"
    apart = {u["name"]: u["usage"]["24h"]["tokens"] for u in found["unmatched"]}
    assert apart == {"Проект": 9000, "项目": 7000, "web": 300, "Sin proyecto": 40}, "cada una aparte, con su nombre"
    connection.close()
