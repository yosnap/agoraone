"""Clients' projects (from Central) with what the agents spent on them: CostGuard's tokens per project, read
by the name of the folder each agent worked in. A project and a folder go together only when their names
are the same once accents, case and punctuation are set aside; whatever does not match is shown apart,
never guessed. Names, states and counts only."""

import re
import sqlite3
import unicodedata
from pathlib import Path

from . import addons, central

PERIODS = (("24h", 24), ("7d", 24 * 7), ("30d", 24 * 30))


def key(name: str | None) -> str:
    """«Café-Web S.L.» and «cafe_web_sl» are the same key; nothing else is assumed."""
    text = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().casefold()
    return re.sub(r"[^a-z0-9]", "", text)


def _usage(connection: sqlite3.Connection, now: float | None) -> tuple[dict[str, dict], bool, str | None]:
    """Tokens and turns per folder key and period, whether CostGuard is set up, and what failed."""
    path = addons.config(connection, "costguard").get("dataPath")
    if not path:
        return {}, False, None
    found: dict[str, dict] = {}
    try:
        for period, hours in PERIODS:
            for row in addons.costguard_projects(Path(path), hours, now, limit=500):
                entry = found.setdefault(key(row["project"]), {"name": row["project"]})
                previous = entry.get(period, {"tokens": 0, "turns": 0})
                entry[period] = {"tokens": previous["tokens"] + row["tokens"], "turns": previous["turns"] + row["turns"]}
    except addons.AddonError as error:
        return {}, True, str(error)
    return found, True, None


def projects(connection: sqlite3.Connection, now: float | None = None) -> dict:
    snapshot = central.snapshot(connection) or {"clients": [], "fetchedAt": None}
    usage, costguard, problem = _usage(connection, now)
    empty = {period: {"tokens": 0, "turns": 0} for period, _ in PERIODS}
    matched: set[str] = set()
    clients = []
    for client in snapshot["clients"]:
        rows = []
        for project in client["projects"]:
            found = usage.get(key(project.get("name")))
            if found and key(project.get("name")):
                matched.add(key(project.get("name")))
            rows.append({"name": project.get("name"), "status": project.get("status"), "phase": project.get("phase"),
                         "usage": {period: found.get(period, empty[period]) for period, _ in PERIODS} if found else None})
        clients.append({"name": client["name"], "company": client.get("company"), "projects": rows})
    unmatched = sorted(({"name": entry["name"], "usage": {period: entry.get(period, empty[period]) for period, _ in PERIODS}}
                        for k, entry in usage.items() if k not in matched and k),
                       key=lambda item: -item["usage"]["30d"]["tokens"])
    return {"clients": clients, "unmatched": unmatched[:50], "costguard": costguard, "problem": problem, "fetchedAt": snapshot.get("fetchedAt")}
