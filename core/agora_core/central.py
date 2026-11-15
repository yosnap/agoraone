"""Central (the user's CRM: clients, projects, websites and servers), read through its own MCP server; the only
thing ever written is a draft quote the user confirmed (`create_quote`, decision of 15/11/2026).

AgoraOne starts Central's MCP server over stdio in Central's folder (the one in the add-on registry) and
calls only reading tools; it never creates quotes or changes phases. The result is kept as a snapshot in
the core's database, refreshed every half hour and on demand, so the brain, Watson and the mail know the
clients (their address, tax id and domains) and the active servers. One day Central's code will live
inside AgoraOne; until then it stays an outside service."""

import asyncio
import json
import os
import re
import shutil
import threading
import sqlite3
from pathlib import Path
from urllib.parse import urlparse

from .db import now, transaction

TOTAL_SECONDS = 180
_REFRESHING = threading.Lock()  # one reading at a time (the half-hourly one or «Actualizar»)
READING_TOOLS = {"list_clients", "list_projects", "list_websites", "list_servers", "get_project"}
SNAPSHOT_SETTING = "central.snapshot"
CALL_SECONDS = 60
_FREE_MAIL = {"gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "yahoo.es", "icloud.com", "me.com",
              "protonmail.com", "proton.me", "gmx.com", "aol.com", "msn.com"}


class CentralError(RuntimeError):
    pass


def _bun() -> str | None:
    return shutil.which("bun") or next((str(p) for p in (Path.home() / ".bun/bin/bun",) if p.exists()), None)


async def _call_all(folder: Path) -> dict:
    from mcp.client.session import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    bun = _bun()
    if not bun:
        raise CentralError("No se encuentra bun, que Central necesita para su servidor MCP.")
    env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG") if k in os.environ}
    params = StdioServerParameters(command=bun, args=["src/mcp/server.ts"], cwd=str(folder), env=env)

    async def call(session, name: str, args: dict | None = None):
        if name not in READING_TOOLS:  # only reading tools, ever
            raise CentralError("Herramienta de Central no permitida.")
        result = await asyncio.wait_for(session.call_tool(name, args or {}), CALL_SECONDS)
        if getattr(result, "isError", False):
            return None
        text = "".join(getattr(part, "text", "") for part in result.content)
        try:
            return json.loads(text)
        except ValueError:
            return None

    def items(value) -> list[dict]:
        return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []

    quiet = open(os.devnull, "w")  # Central's own messages (which may name its database) never reach AgoraOne's log
    try:
        async with stdio_client(params, errlog=quiet) as (read, write):
            async with ClientSession(read, write) as session:
                await asyncio.wait_for(session.initialize(), CALL_SECONDS)
                clients = items(await call(session, "list_clients"))
                projects = items(await call(session, "list_projects", {"limit": 200}))
                websites = items(await call(session, "list_websites"))
                servers = items(await call(session, "list_servers"))
                # The client's address and tax id only come with a project's full record: one per client.
                details: dict[str, dict] = {}
                for project in projects:
                    name = project.get("client")
                    if name and name not in details and project.get("id"):
                        full = await call(session, "get_project", {"id": project["id"]})
                        details[name] = full.get("client") if isinstance(full, dict) and isinstance(full.get("client"), dict) else {}
    finally:
        quiet.close()
    return {"clients": clients, "projects": projects, "websites": websites, "servers": servers, "details": details}


def _domain(value: str | None) -> str | None:
    if not value:
        return None
    host = value.rsplit("@", 1)[-1] if "@" in value and "//" not in value else urlparse(value if "//" in value else f"//{value}").hostname
    host = (host or "").lower().removeprefix("www.")
    return host if re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}", host or "") else None


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
        if email and _domain(email) and _domain(email) not in _FREE_MAIL:
            domains.add(_domain(email))
        by_client[name] = {"name": name, "company": detail.get("company"), "email": email, "taxId": detail.get("taxId"),
                           "domains": domains, "projects": [], "websites": []}
    for site in raw.get("websites", []):
        client = by_client.get(site.get("client") or "")
        if client and site.get("url"):
            client["websites"].append({"url": site["url"], "status": site.get("status")})
            if _domain(site["url"]):
                client["domains"].add(_domain(site["url"]))
    for project in raw.get("projects", []):
        client = by_client.get(project.get("client") or "")
        if client:
            client["projects"].append({"name": project.get("name"), "status": project.get("status"), "phase": project.get("phase")})
    servers = [{"name": s.get("name"), "status": s.get("status") or s.get("liveStatus"), "provider": s.get("provider"),
                "projects": [p.get("name") if isinstance(p, dict) else p for p in (s.get("projects") or [])][:20]}
               for s in raw.get("servers", []) if isinstance(s, dict) and s.get("name")]
    clients = [{**c, "domains": sorted(c["domains"])} for c in sorted(by_client.values(), key=lambda c: c["name"].casefold())]
    return {"clients": clients, "servers": servers, "fetchedAt": now()}


def refresh(connection: sqlite3.Connection, folder: Path, fetch=None) -> dict:
    """Reads Central now and keeps the snapshot. `fetch(folder)` is for tests."""
    if not _REFRESHING.acquire(blocking=False):
        raise CentralError("Ya se está leyendo Central; espera un momento.")
    try:
        raw = fetch(folder) if fetch else asyncio.run(asyncio.wait_for(_call_all(folder), TOTAL_SECONDS))
        snapshot = shape(raw)
    except CentralError:
        raise
    except Exception as error:  # noqa: BLE001 - Central is an outside program: any failure is said plainly
        raise CentralError(f"No se pudo leer Central ({type(error).__name__}). ¿Está su base de datos en marcha?") from error
    finally:
        _REFRESHING.release()
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                           (SNAPSHOT_SETTING, json.dumps(snapshot, ensure_ascii=False)))
    return snapshot


def snapshot(connection: sqlite3.Connection) -> dict | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SNAPSHOT_SETTING,)).fetchone()
    return json.loads(row["value"]) if row else None


def client_for(connection: sqlite3.Connection, address: str | None) -> dict | None:
    """The Central client a sender belongs to: by its exact address, else by its domain (never a free mail
    domain such as gmail.com, which many people share)."""
    data = snapshot(connection)
    if not data or not address:
        return None
    address = address.lower()
    domain = _domain(address)
    exact = next((c for c in data["clients"] if c.get("email") == address), None)
    if exact or not domain or domain in _FREE_MAIL:
        return exact
    return next((c for c in data["clients"] if domain in c["domains"] or any(domain.endswith("." + d) for d in c["domains"])), None)


WRITE_TOOL = "create_quote"  # the only writing tool AgoraOne may call, and only for a quote the user confirmed


def create_quote(folder: Path, quote: dict) -> dict:
    """Creates in Central the draft quote the user confirmed (Central gives it the next number of the year);
    never sends it nor changes a phase. Returns its id and number."""
    async def run():
        from mcp.client.session import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        bun = _bun()
        if not bun:
            raise CentralError("No se encuentra bun, que Central necesita para su servidor MCP.")
        env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG") if k in os.environ}
        async with stdio_client(StdioServerParameters(command=bun, args=["src/mcp/server.ts"], cwd=str(folder), env=env)) as (read, write):
            async with ClientSession(read, write) as session:
                await asyncio.wait_for(session.initialize(), CALL_SECONDS)
                result = await asyncio.wait_for(session.call_tool(WRITE_TOOL, quote), CALL_SECONDS)
                text = "".join(getattr(part, "text", "") for part in result.content)
                if getattr(result, "isError", False):
                    raise CentralError(text[:300] or "Central no pudo crear el presupuesto.")
                try:
                    return json.loads(text)
                except ValueError:
                    return {"text": text[:300]}
    return asyncio.run(asyncio.wait_for(run(), TOTAL_SECONDS))
