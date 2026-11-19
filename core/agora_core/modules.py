"""AgoraOne in modules (1.6, C-02): each one can be turned off in Settings. A module that is off disappears from
the screen, its background work stops and Watson no longer sees its tools; its data stays, for when it is
turned on again. All are on unless the user says otherwise."""

import json
import sqlite3
import threading

from . import addons, crmdev_api, engines
from .db import transaction

SETTING = "modules"
MODULES = {
    "correo": "Correo y Bandeja", "agenda": "Agenda y avisos", "fiscal": "Fiscal", "trabajos": "Trabajos",
    "reuniones": "Reuniones", "voz": "Voz y dictado", "musica": "Música", "oficina": "Oficina 3D", "orca": "Orca",
    "whatsapp": "WhatsApp", "jev": "Jev (decisiones)", "presupuestos": "Presupuestos", "central": "Central",
    "fabrica": "Mi fábrica", "crmdev": "CRMDev",
}
# Modules that no longer exist: dropped from the saved row the next time anything is saved. Any other unknown name is
# kept, so a newer module's setting survives a run of an older core (or a revert).
RETIRED = frozenset({"conectores"})
# Modules split from «trabajos» (which used to cover Central and its quotes): until the user sets them, they are on
# when a source of Central exists (a connection, a snapshot already read or the old folder setting) and off when
# there is none, so nobody loses what already worked and nobody without Central sees them appear.
FOLLOW_CENTRAL = ("central", "presupuestos")
# «Mi fábrica» follows its folder registered as an add-on in the same way until the user sets it.
FOLLOW_FABRICA = "fabrica"
# «CRMDev» follows its connection in the same way: on once a URL is saved, off while there is none.
FOLLOW_CRMDEV = "crmdev"
# Watson's tools that belong to a module.
TOOLS = {"correo": {"proponer_regla", "proponer_limpieza"}, "whatsapp": {"proponer_respuesta_whatsapp"}, "agenda": {"consultar_agenda", "proponer_evento"}, "trabajos": {"consultar_trabajos"}, "presupuestos": {"proponer_presupuesto"},
         "reuniones": {"consultar_reuniones", "leer_reunion", "proponer_issue"}, "orca": {"proponer_encargo_orca"}}
CHECK_EVERY = 20.0


def state(connection: sqlite3.Connection) -> dict[str, bool]:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    saved = json.loads(row["value"]) if row else {}
    default = {name: True for name in MODULES}
    if any(name not in saved for name in FOLLOW_CENTRAL):
        has_central = _central_source(connection)
        default.update({name: has_central for name in FOLLOW_CENTRAL})
    if FOLLOW_FABRICA not in saved:
        default[FOLLOW_FABRICA] = bool(addons.config(connection, "fabrica").get("path"))
    if FOLLOW_CRMDEV not in saved:
        default[FOLLOW_CRMDEV] = crmdev_api.saved_url(connection) is not None
    return {name: saved.get(name, default[name]) is not False for name in MODULES}


def _central_source(connection: sqlite3.Connection) -> bool:
    """A saved connection, a snapshot already read (proof that one worked before) or the old folder setting (only
    the setting is looked at, never the folder)."""
    from . import central, central_api

    return central_api.saved_url(connection) is not None or central.stored(connection) is not None or central.legacy(connection)


def apply(connection: sqlite3.Connection) -> dict[str, bool]:
    """Hides from Watson the tools of the modules that are off (the day summary only when mail and agenda are, the
    Bandeja only when mail and WhatsApp are)."""
    on = state(connection)
    hidden = set().union(*(tools for name, tools in TOOLS.items() if not on[name]))
    if not on["correo"] and not on["agenda"]:
        hidden.add("resumen_del_dia")
    # The Bandeja holds mail and WhatsApp: hidden only when both are off, and each part checks its own module inside.
    if not on["correo"] and not on["whatsapp"]:
        hidden.add("consultar_bandeja")
    engines.HIDDEN_TOOLS.clear()
    engines.HIDDEN_TOOLS.update(hidden)
    return on


def save(connection: sqlite3.Connection, changes: dict) -> dict[str, bool]:
    """Keeps only what the user set: a module never touched keeps following its default. Read and written in one
    transaction, so two switches pressed at once do not lose either change."""
    with transaction(connection):
        row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
        saved = json.loads(row["value"]) if row else {}
        saved = {name: value for name, value in saved.items() if name not in RETIRED}
        saved.update({name: bool(value) for name, value in changes.items() if name in MODULES})
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", (SETTING, json.dumps(saved)))
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
