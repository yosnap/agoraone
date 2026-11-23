"""CRMDev's clients as a snapshot for the directory of clients, so the mail, WhatsApp, meetings, Fiscal and Watson know
them as they know Central's: `crmdev.clients` in `setting`, `{clients: [{id, name, company, email, status, domains}],
projects: [{id, name, status, type, clientId}], counts: {tareas, tickets}, fetchedAt, truncated, projectsTruncated}`
(`counts` holds only how many tasks and tickets there are, for the tabs' counters). Read with `list_clients`
and `list_projects` (tools of the closed list) and a limit of 1000, since CRMDev has no pages: a full answer is
`truncated` and the directory says so. The projects are for linking them with Central's (`project_links`); their
client comes only when CRMDev gives it. Refreshed every half hour while the «CRMDev» module is
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
WAIT_SECONDS = 30  # «Actualizar» while the worker reads: waits for its result
TEXT = 200
EMAIL = 320
STATUSES = frozenset(crmdev_api.STATUSES["list_clients"])
PROJECT_STATUSES = frozenset(crmdev_api.STATUSES["list_projects"])
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
        # The phone only when CRMDev gives it (older versions do not): without it, it is not compared.
        phone = {"phone": _text(row.get("phone"), 40)} if "phone" in row else {}
        found.append({"id": client_id, "name": name, "company": _text(row.get("company")), "email": email if host else None, "status": status,
                      **phone, "domains": [host] if client_domain(host) else []})
    return {"clients": found, "fetchedAt": now(), "truncated": len(data) >= crmdev_api.SYNC_ROWS}


def shape_projects(data: object) -> list[dict]:
    """Each project with a valid id and a name, its state and type when known, and its client's id when CRMDev says it."""
    if not isinstance(data, list):
        raise WebApiError("error", crmdev_api.ODD)
    found = []
    for row in data[: crmdev_api.SYNC_ROWS]:
        if not isinstance(row, dict):
            continue
        project_id, name = row.get("id"), _text(row.get("name"))
        if not isinstance(project_id, str) or not crmdev_api.ID.fullmatch(project_id) or not name:
            continue
        client = row.get("client") if isinstance(row.get("client"), dict) else {}
        client_id = row.get("clientId") if isinstance(row.get("clientId"), str) else client.get("id")
        found.append({"id": project_id, "name": name, "status": row.get("status") if row.get("status") in PROJECT_STATUSES else None,
                      "type": _text(row.get("type"), 40),
                      "clientId": client_id if isinstance(client_id, str) and crmdev_api.ID.fullmatch(client_id) else None})
    return found


def _count(target: Connection, tool: str) -> dict | None:
    """How many tasks or tickets CRMDev gives (only the number, for the tabs' counters; CRMDev gives 100 at most, so
    `more` says there may be more). None when it cannot say (its support module off, or it asks to wait)."""
    try:
        rows = crmdev_api.call(target, tool, {"limit": crmdev_api.MAX_ROWS})
    except WebApiError:
        return None
    return {"n": len(rows), "more": len(rows) >= crmdev_api.MAX_ROWS} if isinstance(rows, list) else None


def setting_of(org: str | None) -> str:
    """Where an organization's snapshot is kept: the first one where the only one was kept before organizations existed."""
    from . import crmdev_orgs

    return SETTING if org in (None, crmdev_orgs.FIRST) else f"{SETTING}:{org}"


def refresh(connection: sqlite3.Connection, target: Connection, org: str | None = None) -> dict:
    """Reads CRMDev's clients now and keeps the snapshot of that organization (the first one when none is said); a
    WebApiError (without the key) when it cannot."""
    from . import crmdev_orgs

    org = org or crmdev_orgs.default(connection)
    if not _REFRESHING.acquire(blocking=False):
        # Another reading (the half-hourly one) is under way: its result is just as fresh, so wait for it.
        if not _REFRESHING.acquire(timeout=WAIT_SECONDS):
            raise WebApiError("busy", "Ya se están leyendo los clientes de CRMDev; espera un momento.")
        _REFRESHING.release()
        found = stored(connection, org)
        if found is not None:
            return found
        _REFRESHING.acquire()
    try:
        snapshot = shape(crmdev_api.call(target, "list_clients", {"limit": crmdev_api.SYNC_ROWS}, fresh=True))
        projects = crmdev_api.call(target, "list_projects", {"limit": crmdev_api.SYNC_ROWS}, fresh=True)
        snapshot["projects"] = shape_projects(projects)
        snapshot["projectsTruncated"] = isinstance(projects, list) and len(projects) >= crmdev_api.SYNC_ROWS
        snapshot["counts"] = {name: _count(target, tool) for name, tool in (("tareas", "list_tasks"), ("tickets", "list_tickets"))}
    finally:
        _REFRESHING.release()
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                           (setting_of(org), json.dumps(snapshot, ensure_ascii=False)))
    return snapshot


def stored(connection: sqlite3.Connection, org: str | None = None) -> dict | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (setting_of(org),)).fetchone()
    try:
        found = json.loads(row["value"]) if row else None
    except (TypeError, ValueError):
        return None
    return found if isinstance(found, dict) and isinstance(found.get("clients"), list) else None


def active(connection: sqlite3.Connection) -> bool:
    """Whether CRMDev is a source of clients now: its module on and its address saved (forgetting only the key keeps
    what was read, as with Central)."""
    return modules.state(connection)["crmdev"] and crmdev_api.saved_url(connection) is not None


def snapshot(connection: sqlite3.Connection, org: str | None = None) -> dict | None:
    """The last snapshot of an organization (the first one when none is said), only while CRMDev is a source of clients."""
    return stored(connection, org) if active(connection) else None


def snapshots(connection: sqlite3.Connection) -> dict[str, dict]:
    """The last snapshot of every organization read at least once, by its id; empty while CRMDev is no source."""
    from . import crmdev_orgs

    if not active(connection):
        return {}
    found = {o["id"]: stored(connection, o["id"]) for o in crmdev_orgs.orgs(connection)}
    return {org: snap for org, snap in found.items() if snap is not None}


def rows(connection: sqlite3.Connection, field: str) -> list[dict]:
    """The clients or projects (`field`) of every organization, each with its `org`."""
    return [{**row, "org": org} for org, snap in snapshots(connection).items() for row in snap.get(field) or [] if isinstance(row, dict)]


def read_now(connection: sqlite3.Connection, secrets, health: CrmdevHealth) -> dict | None:
    """Reads every organization whose key is saved, one after another; the first one's snapshot, or None when no
    organization could be asked. A failure of one does not stop the others; it is said in `health`."""
    from . import crmdev_orgs

    first, problem = None, None
    for org in crmdev_orgs.orgs(connection):
        target = crmdev_api.connection_of(connection, secrets, org["id"])
        if target is None:
            continue
        try:
            data = refresh(connection, target, org["id"])
        except WebApiError as error:  # fixed sentences: never the key nor the address
            if error.status != "busy":  # a passing «wait a moment» of CRMDev is no problem of the connection
                problem = f"{org['name']}: {str(error)}"[:200]
            continue
        first = first or data
    health.problem = problem
    if problem and first is None:
        raise WebApiError("error", problem)
    return first


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
