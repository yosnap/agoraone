"""Add-ons: other projects of the user that AgoraOne connects to without changing them.

Manifests are generic (this repository is public): how each add-on is recognised, what it offers and how
to tell it is running. Where it lives on this Mac (paths, ports) is the user's own setting, stored in the
core's database. Nothing here starts, stops or writes to an add-on.
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
    Manifest("central", "Central", "CRM personal: proyectos, clientes, presupuestos, webs y servidores.",
             ["MCP por stdio (bun src/mcp/server.ts)", "Web local"], {"port": 3099}),
    Manifest("costguard", "CostGuard", "Mide el gasto de tokens de los agentes (Claude Code, Codex, OpenCode, pi).",
             ["Consumo de tokens de las últimas 5 y 24 horas, en solo lectura"],
             {"dataPath": str(Path.home() / "Library" / "Application Support" / "CostGuard" / "consumo.sqlite")}),
    Manifest("fabrica", "Mi fábrica", "Fábrica de contenido: investiga, produce, espera aprobación, publica y mide.",
             ["Panel local", "Nutrirse del cerebro por MCP"], {"port": 8742}),
]}


class AddonError(ValueError):
    pass


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def recognised(addon: str, folder: Path) -> bool:
    """Whether the folder really holds that add-on, judged by its own project files (read, never run)."""
    if addon == "central":
        return _read_json(folder / "package.json").get("name") == "central" and (folder / "src" / "mcp" / "server.ts").is_file()
    if addon == "fabrica":
        try:
            text = (folder / "pyproject.toml").read_text(encoding="utf-8")
        except OSError:
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
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}{path}", timeout=1) as response:
            return response.status == 200
    except OSError:
        return False


def config(connection: sqlite3.Connection, addon: str) -> dict:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (f"addons.{addon}",)).fetchone()
    return {**MANIFESTS[addon].defaults, **(json.loads(row["value"]) if row else {})}


def save_config(connection: sqlite3.Connection, addon: str, changes: dict) -> dict:
    """Validates where the add-on is (absolute path that holds it, port 1024-65535) and stores it."""
    if addon not in MANIFESTS:
        raise AddonError("Complemento desconocido.")
    current = config(connection, addon)
    for key, value in changes.items():
        if key == "port":
            if not isinstance(value, int) or not 1024 <= value <= 65535:
                raise AddonError("Puerto no válido.")
        elif key in ("path", "dataPath"):
            if not isinstance(value, str) or not Path(value).is_absolute() or len(value) > 500:
                raise AddonError("La ruta debe ser absoluta.")
            target = Path(value)
            if key == "path" and not (target.is_dir() and recognised(addon, target)):
                raise AddonError(f"Esa carpeta no contiene {MANIFESTS[addon].name}.")
            if key == "dataPath" and not target.is_file():
                raise AddonError("No se encuentra ese archivo de datos.")
        else:
            raise AddonError("Ajuste desconocido.")
        current[key] = value
    stored = {k: v for k, v in current.items() if MANIFESTS[addon].defaults.get(k) != v}
    connection.execute(
        "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (f"addons.{addon}", json.dumps(stored)),
    )
    return current


def status(addon: str, settings: dict) -> str:
    """not_configured, not_found, detected or running."""
    if addon == "costguard":
        data = Path(settings.get("dataPath") or "")
        if not settings.get("dataPath"):
            return "not_configured"
        if not data.is_file():
            return "not_found"
        usage = costguard_usage(data, hours=2)
        return "running" if usage["turns"] else "detected"
    if not settings.get("path"):
        return "not_configured"
    if not recognised(addon, Path(settings["path"])):
        return "not_found"
    running = _listening(settings.get("port")) if addon == "central" else _healthy(settings.get("port"), "/salud")
    return "running" if running else "detected"


def describe(connection: sqlite3.Connection) -> list[dict]:
    found = []
    for manifest in MANIFESTS.values():
        settings = config(connection, manifest.id)
        found.append({
            "id": manifest.id, "name": manifest.name, "description": manifest.description, "offers": manifest.offers,
            "status": status(manifest.id, settings), "configured": settings,
        })
    return found


def costguard_usage(database: Path, hours: int = 5, now: float | None = None) -> dict:
    """Tokens per agent in the last `hours`, read from CostGuard's own database in read-only mode."""
    since = int((now or time.time()) - hours * 3600)
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        rows = connection.execute(
            """SELECT agente, sum(gi), sum(go), sum(cr), sum(cw), sum(turnos) FROM horas
               WHERE hora >= ? GROUP BY agente ORDER BY sum(gi) + sum(go) DESC""",
            (since - since % 3600,),
        ).fetchall()
    except sqlite3.Error as error:
        raise AddonError("No se pudieron leer los datos de CostGuard.") from error
    finally:
        connection.close()
    agents = [{"agent": a, "input": i or 0, "output": o or 0, "cacheRead": r or 0, "cacheWrite": w or 0, "turns": t or 0}
              for a, i, o, r, w, t in rows]
    return {"hours": hours, "agents": agents, "turns": sum(a["turns"] for a in agents)}
