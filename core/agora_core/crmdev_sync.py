"""CRMDev's clients as a snapshot for the directory of clients, so the mail, WhatsApp, meetings, Fiscal and Watson know
them as they know Central's: `crmdev.clients` in `setting`, `{clients: [{id, name, company, email, status, domains}],
fetchedAt, truncated}`. Read with `list_clients` (a tool of the closed list) and a limit of 1000, since CRMDev has no
pages: a full answer is `truncated` and the directory says so. Refreshed every half hour while the «CRMDev» module is
on (`modules.gated`) and on «Actualizar». Only those fields are kept, trimmed; nothing else of CRMDev is stored.

The snapshot is used only while the module is on and CRMDev's address is saved: turned off, it stays but nothing uses
it, and nothing is deleted. Forgetting only the key keeps what was read, as with Central. What CRMDev answers is data: never read as instructions."""

import json
import sqlite3
import sys
import threading

from . import crmdev_api, modules
from .clients import client_domain, domain
from .db import DB_NAME, connect, now, transaction
from .web_api import Connection, WebApiError

SETTING = "crmdev.clients"
REFRESH_SECONDS = 1800
TEXT = 200
EMAIL = 320
STATUSES = frozenset(crmdev_api.STATUSES["list_clients"])
_REFRESHING = threading.Lock()  # one reading at a time (the half-hourly one or «Actualizar»)


class CrmdevHealth:
    def __init__(self):
        self.problem: str | None = None


def _text(value: object, limit: int = TEXT) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())[:limit]
    return text or None


def shape(data: object) -> dict:
    """The snapshot kept: each client with a valid id and a name, its mail lowercased (and its domain when it may
    stand for one client: never a mail provider's nor a public suffix)."""
    if not isinstance(data, list):
        raise WebApiError("error", crmdev_api.ODD)
    found = []
    for row in data[: crmdev_api.SYNC_ROWS]:
        if not isinstance(row, dict):
            continue
        client_id, name = row.get("id"), _text(row.get("name"))
        if not isinstance(client_id, str) or not crmdev_api.ID.fullmatch(client_id) or not name:
            continue
        email = (_text(row.get("email"), EMAIL) or "").lower() or None
        host = domain(email) if email and "@" in email else None
        status = row.get("status") if row.get("status") in STATUSES else None
        found.append({"id": client_id, "name": name, "company": _text(row.get("company")), "email": email if host else None, "status": status,
                      "domains": [host] if client_domain(host) else []})
    return {"clients": found, "fetchedAt": now(), "truncated": len(data) >= crmdev_api.SYNC_ROWS}


def refresh(connection: sqlite3.Connection, target: Connection) -> dict:
    """Reads CRMDev's clients now and keeps the snapshot; a WebApiError (without the key) when it cannot."""
    if not _REFRESHING.acquire(blocking=False):
        raise WebApiError("busy", "Ya se están leyendo los clientes de CRMDev; espera un momento.")
    try:
        snapshot = shape(crmdev_api.call(target, "list_clients", {"limit": crmdev_api.SYNC_ROWS}, fresh=True))
    finally:
        _REFRESHING.release()
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                           (SETTING, json.dumps(snapshot, ensure_ascii=False)))
    return snapshot


def stored(connection: sqlite3.Connection) -> dict | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    try:
        found = json.loads(row["value"]) if row else None
    except (TypeError, ValueError):
        return None
    return found if isinstance(found, dict) and isinstance(found.get("clients"), list) else None


def active(connection: sqlite3.Connection) -> bool:
    """Whether CRMDev is a source of clients now: its module on and its address saved (forgetting only the key keeps
    what was read, as with Central)."""
    return modules.state(connection)["crmdev"] and crmdev_api.saved_url(connection) is not None


def snapshot(connection: sqlite3.Connection) -> dict | None:
    """The last snapshot, only while CRMDev is a source of clients."""
    return stored(connection) if active(connection) else None


def read_now(connection: sqlite3.Connection, secrets, health: CrmdevHealth) -> dict | None:
    """Reads CRMDev's clients when connected; None (nothing asked) otherwise."""
    target = crmdev_api.connection_of(connection, secrets)
    if target is None:
        return None
    try:
        data = refresh(connection, target)
    except WebApiError as error:  # fixed sentences: never the key nor the address
        health.problem = str(error)[:200]
        raise
    health.problem = None
    return data


def crmdev_worker(settings, stop: threading.Event, health: CrmdevHealth, secrets) -> None:
    """Every half hour while the «CRMDev» module is on (run inside `modules.gated`)."""
    stop.wait(45)
    while not stop.is_set():
        try:
            connection = connect(settings.data_dir / DB_NAME)
            try:
                read_now(connection, secrets, health)
            finally:
                connection.close()
        except WebApiError:
            pass  # already said in `health`
        except Exception as error:  # noqa: BLE001 - the worker survives anything and says so
            if health.problem is None:
                print(f"AgoraOne núcleo: lectura de clientes de CRMDev en pausa ({type(error).__name__})", file=sys.stderr)
            health.problem = "No se pudieron leer los clientes de CRMDev."
        stop.wait(REFRESH_SECONDS)
