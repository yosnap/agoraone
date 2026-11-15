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
