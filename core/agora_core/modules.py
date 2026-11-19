"""AgoraOne in modules (1.6, C-02): each one can be turned off in Settings. A module that is off disappears from
the screen, its background work stops and Watson no longer sees its tools; its data stays, for when it is
turned on again. All are on unless the user says otherwise."""

import json
import sqlite3
import threading

from . import engines
from .db import transaction

SETTING = "modules"
MODULES = {
    "correo": "Correo y Bandeja", "agenda": "Agenda y avisos", "fiscal": "Fiscal", "trabajos": "Trabajos y Central",
    "reuniones": "Reuniones", "voz": "Voz y dictado", "musica": "Música", "oficina": "Oficina 3D", "conectores": "Conectores",
}
# Watson's tools that belong to a module.
TOOLS = {"correo": {"consultar_bandeja", "proponer_regla"}, "agenda": {"consultar_agenda"}, "trabajos": {"consultar_trabajos", "consultar_clientes"}}
CHECK_EVERY = 20.0


def state(connection: sqlite3.Connection) -> dict[str, bool]:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    saved = json.loads(row["value"]) if row else {}
    return {name: saved.get(name, True) is not False for name in MODULES}


def apply(connection: sqlite3.Connection) -> dict[str, bool]:
    """Hides from Watson the tools of the modules that are off (the day summary only when mail and agenda are)."""
    on = state(connection)
    hidden = set().union(*(tools for name, tools in TOOLS.items() if not on[name]))
    if not on["correo"] and not on["agenda"]:
        hidden.add("resumen_del_dia")
    engines.HIDDEN_TOOLS.clear()
    engines.HIDDEN_TOOLS.update(hidden)
    return on


def save(connection: sqlite3.Connection, changes: dict) -> dict[str, bool]:
    on = state(connection)
    on.update({name: bool(value) for name, value in changes.items() if name in MODULES})
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", (SETTING, json.dumps(on)))
    return apply(connection)


def gated(module: str, connect, run, stop: threading.Event) -> None:
    """Runs a background worker only while its module is on: it gets its own stop, set when the module is
    turned off (the worker ends at its next check) or when AgoraOne stops; turned on again, it starts anew."""
    running: tuple[threading.Thread, threading.Event] | None = None
    while not stop.is_set():
        try:
            connection = connect()
            try:
                on = state(connection)[module]
            finally:
                connection.close()
        except Exception:  # noqa: BLE001 - unreadable for a moment: keep things as they are
            on = running is not None
        alive = running is not None and running[0].is_alive()
        if on and not alive:
            own = threading.Event()
            thread = threading.Thread(target=run, args=(own,), daemon=True)
            thread.start()
            running = (thread, own)
        elif not on and alive:
            running[1].set()
            running = None
        stop.wait(CHECK_EVERY)
    if running:
        running[1].set()
