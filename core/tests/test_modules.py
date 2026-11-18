"""Modules: all on by default; one turned off hides Watson's tools for it and stops its background work."""

import threading
import time

from agora_core import engines, modules
from agora_core.db import DB_NAME, connect, migrate


def test_modulos(tmp_path, monkeypatch):
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    assert all(on for name, on in modules.state(c).items() if name not in (*modules.FOLLOW_CENTRAL, modules.FOLLOW_FABRICA))
    modules.save(c, {"correo": False, "inventado": False})
    assert modules.state(c)["correo"] is False and "inventado" not in modules.state(c)
    names = [s["name"] for s in engines._specs()]
    assert "consultar_bandeja" not in names and "proponer_regla" not in names and "consultar_agenda" in names
    modules.save(c, {"correo": True})
    assert "consultar_bandeja" in [s["name"] for s in engines._specs()]
    # The supervisor starts the worker while the module is on and stops it when it is turned off.
    monkeypatch.setattr(modules, "CHECK_EVERY", 0.05)
    ran, stop = [], threading.Event()
    def worker(own):
        ran.append("start")
        own.wait()
        ran.append("stop")
    supervisor = threading.Thread(target=modules.gated, args=("correo", lambda: connect(tmp_path / DB_NAME), worker, stop), daemon=True)
    supervisor.start()
    time.sleep(0.2)
    modules.save(c, {"correo": False})
    time.sleep(0.3)
    assert ran == ["start", "stop"]
    stop.set()
    modules.save(c, {"correo": True})
    c.close()


def test_central_y_presupuestos_siguen_a_la_fuente_de_central(tmp_path):
    """Central and Presupuestos used to be part of «Trabajos»: until the user sets them, they are on when a source of
    Central exists (folder, connection or a snapshot already read), even with Trabajos off, and off without one."""
    import json

    from agora_core import addons, central_api

    c = connect(tmp_path / DB_NAME)
    migrate(c)
    c.execute("INSERT INTO setting (key, value) VALUES ('modules', ?)", (json.dumps({"trabajos": False}),))
    on = modules.state(c)
    assert on["trabajos"] is False and on["central"] is False and on["presupuestos"] is False, "sin Central, apagados"
    c.execute("INSERT INTO setting (key, value) VALUES ('addons.central', ?)", (json.dumps({"path": "/ruta/de/central"}),))
    on = modules.state(c)
    assert on["trabajos"] is False and on["central"] is True and on["presupuestos"] is True, "con la carpeta, nadie pierde Central"
    c.execute("DELETE FROM setting WHERE key = 'addons.central'")
    central_api.save_url(c, "https://central.example.com")
    assert modules.state(c)["central"] is True, "con una conexión, también"
    assert addons.config(c, "central").get("path") is None
    # Saving one module keeps only that one: the others keep following their default.
    modules.save(c, {"correo": True})
    assert json.loads(c.execute("SELECT value FROM setting WHERE key = 'modules'").fetchone()["value"]) == {"trabajos": False, "correo": True}
    modules.save(c, {"central": False})
    central_api.save_url(c, None)
    on = modules.state(c)
    assert on["central"] is False and on["presupuestos"] is False
    modules.save(c, {"central": True})
    assert modules.state(c)["central"] is True, "lo que elige el usuario manda"
    # Trabajos off no longer hides the quotes; Presupuestos off does. The clients' lookup belongs to no module.
    modules.save(c, {"presupuestos": True})
    names = [s["name"] for s in engines._specs()]
    assert "consultar_trabajos" not in names and "proponer_presupuesto" in names and "consultar_clientes" in names
    modules.save(c, {"trabajos": True, "presupuestos": False})
    names = [s["name"] for s in engines._specs()]
    assert "consultar_trabajos" in names and "proponer_presupuesto" not in names
    modules.save(c, {"presupuestos": True})
    c.close()
