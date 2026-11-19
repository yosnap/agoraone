"""Add-ons: other projects of the user that AgoraOne connects to without changing them.

Manifests are generic (this repository is public): how each add-on is recognised, what it offers and how
to tell it is running. Where it lives on this Mac (paths, ports) is the user's own setting, stored in the
core's database. Nothing here starts, stops or writes to an add-on; the one exception, starting Mi fábrica's own
launchd service on macOS at the user's request, lives in `fabrica_service.py`.
"""

import json
import socket
import sqlite3
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Manifest:
    id: str
    name: str
    description: str
    offers: list[str]
    defaults: dict = field(default_factory=dict)


MANIFESTS = {m.id: m for m in [
    Manifest("costguard", "CostGuard", "Mide el gasto de tokens de los agentes (Claude Code, Codex, OpenCode, pi).",
             ["Consumo de tokens de las últimas 5 y 24 horas, en solo lectura"],
             {"dataPath": str(Path.home() / "Library" / "Application Support" / "CostGuard" / "consumo.sqlite")}),
    Manifest("fabrica", "Mi fábrica", "Fábrica de contenido: investiga, produce, espera aprobación, publica y mide.",
             ["Panel local", "Nutrirse del cerebro por MCP"], {"port": 8742}),
]}


ALLOWED = {"fabrica": {"path", "port"}, "costguard": {"dataPath"}}
COSTGUARD_COLUMNS = {"hora", "agente", "gi", "go", "cr", "cw", "turnos"}


class AddonError(ValueError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


# Health checks go straight to 127.0.0.1: no proxy and no redirect that could send them elsewhere.
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def recognised(addon: str, folder: Path) -> bool:
    """Whether the folder really holds that add-on, judged by its own project files (read, never run)."""
    if addon == "fabrica":
        try:
            text = (folder / "pyproject.toml").read_text(encoding="utf-8")
        except (OSError, ValueError):  # unreadable, not UTF-8 (UnicodeDecodeError) or a bad path: not the fábrica
            return False
        return 'name = "mi-fabrica"' in text
    return False


def _listening(port: int | None) -> bool:
    if not port:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def _healthy(port: int | None, path: str) -> bool:
    if not _listening(port):
        return False
    try:
        with _LOCAL.open(f"http://127.0.0.1:{port}{path}", timeout=1) as response:
            return response.status == 200
    except OSError:
        return False


def config(connection: sqlite3.Connection, addon: str) -> dict:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (f"addons.{addon}",)).fetchone()
    return {**MANIFESTS[addon].defaults, **(json.loads(row["value"]) if row else {})}


def save_config(connection: sqlite3.Connection, addon: str, changes: dict) -> dict:
    """Validates where the add-on is and stores it. Each add-on accepts only its own settings; None forgets
    a setting (back to the default or to «not configured»)."""
    if addon not in MANIFESTS:
        raise AddonError("Complemento desconocido.")
    current = config(connection, addon)
    for key, value in changes.items():
        if key not in ALLOWED[addon]:
            raise AddonError("Ajuste no válido para este complemento.")
        if value is None:
            current.pop(key, None)
            if key in MANIFESTS[addon].defaults:
                current[key] = MANIFESTS[addon].defaults[key]
            continue
        if key == "port":
            if type(value) is not int or not 1024 <= value <= 65535:
                raise AddonError("Puerto no válido.")
        else:
            if not isinstance(value, str) or not Path(value).is_absolute() or len(value) > 500:
                raise AddonError("La ruta debe ser absoluta.")
            target = Path(value)
            if key == "path" and not (target.is_dir() and recognised(addon, target)):
                raise AddonError(f"Esa carpeta no contiene {MANIFESTS[addon].name}.")
            if key == "dataPath" and not is_costguard_data(target):
                raise AddonError("Ese archivo no es una base de datos de CostGuard.")
        current[key] = value
    stored = {k: v for k, v in current.items() if MANIFESTS[addon].defaults.get(k) != v}
    connection.execute(
        "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (f"addons.{addon}", json.dumps(stored)),
    )
    return current


def status(addon: str, settings: dict) -> str:
    """not_configured, not_found, unreadable, detected, responding (its web answers) or recording (CostGuard
    has usage from the last hours: it is a menu-bar app without a web of its own). Never raises."""
    try:
        if addon == "costguard":
            if not settings.get("dataPath"):
                return "not_configured"
            data = Path(settings["dataPath"])
            if not data.is_file():
                return "not_found"
            if not is_costguard_data(data):
                return "unreadable"
            return "recording" if costguard_usage(data, hours=2)["turns"] else "detected"
        if not settings.get("path"):
            return "not_configured"
        if not recognised(addon, Path(settings["path"])):
            return "not_found"
        return "responding" if _healthy(settings.get("port"), "/salud") else "detected"
    except Exception:  # noqa: BLE001 - one add-on in a bad state must not break the whole registry
        return "unreadable"


def describe(connection: sqlite3.Connection) -> list[dict]:
    found = []
    for manifest in MANIFESTS.values():
        settings = config(connection, manifest.id)
        found.append({
            "id": manifest.id, "name": manifest.name, "description": manifest.description, "offers": manifest.offers,
            "status": status(manifest.id, settings), "configured": settings,
        })
    return found


def _open_costguard(database: Path) -> sqlite3.Connection:
    """Read-only. With no WAL file present (CostGuard closed), immutable=1 so SQLite creates nothing next to it."""
    wal = Path(f"{database}-wal").exists()
    uri = database.resolve().as_uri() + ("?mode=ro" if wal else "?mode=ro&immutable=1")
    connection = sqlite3.connect(uri, uri=True, timeout=2)
    return connection


def is_costguard_data(database: Path) -> bool:
    """A SQLite file with CostGuard's hourly usage table and its columns."""
    if not database.is_file():
        return False
    try:
        connection = _open_costguard(database)
        try:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(horas)")}
        finally:
            connection.close()
    except sqlite3.Error:
        return False
    return COSTGUARD_COLUMNS <= columns


def costguard_usage(database: Path, hours: int = 5, now: float | None = None) -> dict:
    """Tokens per agent in the last `hours` hourly buckets (the current one included), read from
    CostGuard's own database in read-only mode. Its `hora` column is the epoch second the hour starts."""
    moment = int(time.time() if now is None else now)
    start = (moment // 3600 - (hours - 1)) * 3600
    try:
        connection = _open_costguard(database)
        try:
            rows = connection.execute(
                """SELECT agente, sum(gi), sum(go), sum(cr), sum(cw), sum(turnos) FROM horas
                   WHERE hora >= ? GROUP BY agente ORDER BY sum(gi) + sum(go) DESC""",
                (start,),
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.Error as error:
        raise AddonError("No se pudieron leer los datos de CostGuard.") from error
    agents = [{"agent": a, "input": i or 0, "output": o or 0, "cacheRead": r or 0, "cacheWrite": w or 0, "turns": t or 0}
              for a, i, o, r, w, t in rows]
    return {"hours": hours, "agents": agents, "turns": sum(a["turns"] for a in agents)}


def costguard_projects(database: Path, hours: int, now: float | None = None, limit: int = 15) -> list[dict]:
    """Tokens per project (CostGuard's `proyecto_raw`, reduced to its last name, never a path) in the last
    `hours`, read-only like costguard_usage."""
    moment = int(time.time() if now is None else now)
    start = (moment // 3600 - (hours - 1)) * 3600
    try:
        connection = _open_costguard(database)
        try:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(horas)")}
            if "proyecto_raw" not in columns:
                return []
            rows = connection.execute(
                """SELECT proyecto_raw, sum(gi) + sum(go), sum(cr) + sum(cw), sum(turnos) FROM horas
                   WHERE hora >= ? GROUP BY proyecto_raw""",
                (start,),
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.Error as error:
        raise AddonError("No se pudieron leer los datos de CostGuard.") from error
    totals: dict[str, list[int]] = {}
    for raw, tokens, cached, turns in rows:
        name = Path(str(raw or "").rstrip("/")).name.strip() or "Sin proyecto"
        total = totals.setdefault(name, [0, 0, 0])
        total[0] += tokens or 0
        total[1] += cached or 0
        total[2] += turns or 0
    ranked = sorted(totals.items(), key=lambda item: -item[1][0])[:limit]
    return [{"project": name, "tokens": t, "cacheTokens": c, "turns": n} for name, (t, c, n) in ranked]
