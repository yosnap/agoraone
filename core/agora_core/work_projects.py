"""Clients' projects (from Central) with what the agents spent on them: CostGuard's tokens per project, read
by the name of the folder each agent worked in. A project and a folder go together only when their names
are the same once accents, case and punctuation are set aside; whatever does not match is shown apart,
never guessed. Names, states and counts only."""

import sqlite3
import time
from pathlib import Path

from . import addons, central
from . import clients as client_directory

PERIODS = (("24h", 24), ("7d", 24 * 7), ("30d", 24 * 30))


key = client_directory.loose  # «Café-Web S.L.» and «cafe_web_sl» are the same key; nothing else is assumed


def _usage(connection: sqlite3.Connection, now: float | None) -> tuple[dict[str, dict], bool, str | None]:
    """Tokens (CostGuard's input and output, without cache) and turns per folder and period, read once for
    the 30 days and with no cap; whether CostGuard is set up, and what failed. Folders whose name gives no
    key (only non-Latin letters or signs) and CostGuard's nameless bucket are kept apart under their own
    name: they never match a project."""
    path = addons.config(connection, "costguard").get("dataPath")
    if not path:
        return {}, False, None
    moment = int(time.time() if now is None else now)
    starts = {period: (moment // 3600 - (hours - 1)) * 3600 for period, hours in PERIODS}
    try:
        source = addons._open_costguard(Path(path))  # noqa: SLF001 - same read-only opening as the rest of CostGuard's readers
        try:
            columns = {row[1] for row in source.execute("PRAGMA table_info(horas)")}
            if not {"proyecto_raw", "hora", "gi", "go", "turnos"} <= columns:
                return {}, True, None
            rows = source.execute("SELECT proyecto_raw, hora, sum(gi) + sum(go), sum(turnos) FROM horas WHERE hora >= ? GROUP BY proyecto_raw, hora",
                                  (starts["30d"],)).fetchall()
        finally:
            source.close()
    except sqlite3.Error:
        return {}, True, "No se pudieron leer los datos de CostGuard."
    found: dict[str, dict] = {}
    for raw, hour, tokens, turns in rows:
        name = Path(str(raw or "").rstrip("/")).name.strip()
        k = key(name)
        entry = found.setdefault(k if k else f"#{name or 'Sin proyecto'}", {"name": name or "Sin proyecto", "matchable": bool(k)})
        for period, _ in PERIODS:
            if hour >= starts[period]:
                previous = entry.get(period, {"tokens": 0, "turns": 0})
                entry[period] = {"tokens": previous["tokens"] + (tokens or 0), "turns": previous["turns"] + (turns or 0)}
    return found, True, None


def projects(connection: sqlite3.Connection, now: float | None = None) -> dict:
    # Projects live in Central: the directory gives them under the name the client goes by (a client kept only in
    # AgoraOne has none and is left out here).
    snapshot = {"clients": [c for c in client_directory.directory(connection) if c["source"] != "local"],
                "fetchedAt": (central.snapshot(connection) or {}).get("fetchedAt")}
    usage, costguard, problem = _usage(connection, now)
    empty = {period: {"tokens": 0, "turns": 0} for period, _ in PERIODS}
    # A name shared by two projects (of the same or different clients) cannot tell which one a folder is for.
    seen: dict[str, int] = {}
    for client in snapshot["clients"]:
        for project in client["projects"]:
            if key(project.get("name")):
                seen[key(project.get("name"))] = seen.get(key(project.get("name")), 0) + 1
    matched: set[str] = set()
    clients = []
    for client in snapshot["clients"]:
        rows = []
        for project in client["projects"]:
            k = key(project.get("name"))
            ambiguous = bool(k) and seen.get(k, 0) > 1
            found = usage.get(k) if k and not ambiguous else None
            if found and found.get("matchable"):
                matched.add(k)
            else:
                found = None
            rows.append({"name": project.get("name"), "status": project.get("status"), "phase": project.get("phase"), "ambiguous": ambiguous,
                         "usage": {period: found.get(period, empty[period]) for period, _ in PERIODS} if found else None})
        clients.append({"name": client["name"], "projects": rows})
    unmatched = [{"name": entry["name"], "usage": {period: entry.get(period, empty[period]) for period, _ in PERIODS}}
                 for k, entry in usage.items() if k not in matched]
    unmatched.sort(key=lambda item: -item["usage"]["30d"]["tokens"])
    return {"clients": clients, "unmatched": unmatched, "costguard": costguard, "problem": problem, "fetchedAt": snapshot.get("fetchedAt")}
