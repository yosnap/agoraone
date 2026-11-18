"""Modules: all on by default; one turned off hides Watson's tools for it and stops its background work."""

import threading
import time

from agora_core import engines, modules
from agora_core.db import DB_NAME, connect, migrate


def test_modulos(tmp_path, monkeypatch):
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    assert all(modules.state(c).values())
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


def test_central_y_presupuestos_heredan_de_trabajos(tmp_path):
    """Central and Presupuestos used to be part of «Trabajos»: whoever had it off does not see them appear."""
    import json

    c = connect(tmp_path / DB_NAME)
    migrate(c)
    c.execute("INSERT INTO setting (key, value) VALUES ('modules', ?)", (json.dumps({"trabajos": False, "correo": True}),))
    on = modules.state(c)
    assert on["trabajos"] is False and on["central"] is False and on["presupuestos"] is False
    modules.save(c, {"trabajos": True})
    assert modules.state(c)["central"] is False, "guardado una vez, cada uno va por su cuenta"
    modules.save(c, {"central": True, "trabajos": False})
    on = modules.state(c)
    assert on["central"] is True and on["presupuestos"] is False and on["trabajos"] is False
    # Trabajos off no longer hides the quotes; Presupuestos off does. The clients' lookup belongs to no module.
    names = [s["name"] for s in engines._specs()]
    assert "consultar_trabajos" not in names and "proponer_presupuesto" not in names and "consultar_clientes" in names
    modules.save(c, {"trabajos": True, "presupuestos": True})
    names = [s["name"] for s in engines._specs()]
    assert "consultar_trabajos" in names and "proponer_presupuesto" in names
    c.close()
