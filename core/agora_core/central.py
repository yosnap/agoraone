"""Central (the user's CRM: clients, projects, websites and servers), a separate app AgoraOne connects to; the only
thing ever written is a draft quote the user confirmed (`create_quote`, decision of 15/11/2026).

Central stays its own application, local or remote (user's decision, 18/11/2026). AgoraOne reaches it through its
HTTP API with a URL and an access key (`central_api.py`), and in no other way: its code, its folder and its own
runtime are never needed. Only reading is done, apart from that draft quote.
The result is kept as a snapshot in the core's database, refreshed every half hour and on demand, so the brain,
Watson and the mail know the clients (their address, tax id and domains) and the active servers."""

import json
import re
import threading
import sqlite3

from . import central_api
from .clients import client_domain as _client_domain, domain as _domain
from .db import now, transaction

_REFRESHING = threading.Lock()  # one reading at a time (the half-hourly one or «Actualizar»)
SNAPSHOT_SETTING = "central.snapshot"
# Where the retired folder-and-port way kept Central's place. Kept (never read as a folder, never run) only to tell
# its user how to connect now; it goes away once a connection over the API is saved.
LEGACY_SETTING = "addons.central"
MOVED = "Ahora Central se conecta con su dirección y una clave de acceso: créala en Ajustes › Apps conectadas de Central."


class CentralError(RuntimeError):
    pass


class NoReadingError(CentralError):
    """The connected key has no «lectura» permission: nothing to read over HTTP, and nothing broken."""


_GITHUB = re.compile(r"(?:https://(?:www\.)?github\.com/|git@github\.com:)((?!-)[A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100}?)(?:\.git)?/?")


def github_repo(value) -> str | None:
    """«owner/name» of a project's GitHub repository, from the address Central keeps; None for anything else."""
    found = _GITHUB.fullmatch(str(value or "").strip())
    return f"{found[1]}/{found[2]}" if found and found[2] not in (".", "..") else None


def shape(raw: dict) -> dict:
    """The snapshot AgoraOne keeps: clients with contact, domains and projects; servers with their state."""
    by_client: dict[str, dict] = {}
    for client in raw.get("clients", []):
        name = client.get("name")
        if not name:
            continue
        detail = raw.get("details", {}).get(name, {})
        email = (detail.get("email") or "").strip().lower() or None
        domains = set()
        if email and _client_domain(_domain(email)):
            domains.add(_domain(email))
        by_client[name] = {"id": client.get("id"), "name": name, "company": detail.get("company"), "email": email, "phone": detail.get("phone"),
                           "taxId": detail.get("taxId"), "domains": domains, "projects": [], "websites": []}
    for site in raw.get("websites", []):
        client = by_client.get(site.get("client") or "")
        if client and site.get("url"):
            client["websites"].append({"url": site["url"], "status": site.get("status")})
            if _client_domain(_domain(site["url"])):
                client["domains"].add(_domain(site["url"]))
    for project in raw.get("projects", []):
        client = by_client.get(project.get("client") or "")
        if client:
            client["projects"].append({"name": project.get("name"), "status": project.get("status"), "phase": project.get("phase"),
                                       "repo": github_repo(project.get("repo"))})
    servers = [{"name": s.get("name"), "status": s.get("status") or s.get("liveStatus"), "provider": s.get("provider"),
                "projects": [p.get("name") if isinstance(p, dict) else p for p in (s.get("projects") or [])][:20]}
               for s in raw.get("servers", []) if isinstance(s, dict) and s.get("name")]
    clients = [{**c, "domains": sorted(c["domains"])} for c in sorted(by_client.values(), key=lambda c: c["name"].casefold())]
    return {"clients": clients, "servers": servers, "fetchedAt": now()}


def source(connection: sqlite3.Connection, secrets) -> central_api.Connection | None:
    """Central's HTTP API when there are a saved URL and key; None otherwise."""
    return central_api.connection_of(connection, secrets)


def legacy(connection: sqlite3.Connection) -> bool:
    """Whether the old folder setting is still there (with a path), so its user is told the new way."""
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (LEGACY_SETTING,)).fetchone()
    try:
        saved = json.loads(row["value"]) if row else {}
    except ValueError:
        return False
    return isinstance(saved, dict) and bool(saved.get("path"))


def forget_legacy(connection: sqlite3.Connection) -> None:
    with transaction(connection):
        connection.execute("DELETE FROM setting WHERE key = ?", (LEGACY_SETTING,))


def refresh(connection: sqlite3.Connection, origin: central_api.Connection, fetch=None) -> dict:
    """Reads Central now and keeps the snapshot. `fetch(origin)` is for tests."""
    if not _REFRESHING.acquire(blocking=False):
        raise CentralError("Ya se está leyendo Central; espera un momento.")
    try:
        raw = fetch(origin) if fetch else central_api.read_all(origin)
        snapshot = shape(raw)
    except CentralError:
        raise
    except central_api.NoReadingError as error:
        raise NoReadingError(str(error)) from None
    except central_api.CentralApiError as error:  # its message never carries the key
        raise CentralError(str(error)) from None
    except Exception as error:  # noqa: BLE001 - Central is an outside program: any failure is said plainly
        raise CentralError(f"No se pudo leer Central ({type(error).__name__}).") from None
    finally:
        _REFRESHING.release()
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                           (SNAPSHOT_SETTING, json.dumps(snapshot, ensure_ascii=False)))
    return snapshot


def snapshot(connection: sqlite3.Connection) -> dict | None:
    """The last snapshot, only while the «Central» module is on: turned off, it is kept but nothing uses it."""
    from . import modules

    if not modules.state(connection)["central"]:
        return None
    return stored(connection)


def stored(connection: sqlite3.Connection) -> dict | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SNAPSHOT_SETTING,)).fetchone()
    return json.loads(row["value"]) if row else None


def client_for(connection: sqlite3.Connection, address: str | None) -> dict | None:
    """The client a sender belongs to, in the directory of clients (Central's and the user's own): by its exact
    address, else by its domain (never a free mail domain such as gmail.com, which many people share)."""
    from . import clients

    return clients.match(connection, address=address)


def create_quote(origin: central_api.Connection, quote: dict) -> dict:
    """Creates in Central the draft quote the user confirmed (Central gives it the next number of the year);
    never sends it nor changes a phase. Returns its id and number."""
    try:
        return central_api.create_quote(origin, quote)
    except central_api.CentralApiError as error:
        raise CentralError(str(error)) from None
