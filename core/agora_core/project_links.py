"""Which of Central's projects is which of CRMDev's (user's decision, 20/11/2026: Central is the source and CRMDev
follows it). Only reads both snapshots (`central.snapshot` and `crmdev_sync.snapshot`) and the user's links in
`project_link`; nothing is copied between them here.

A pair is, first, the one the user linked («Enlazar»). Otherwise, the same name on both sides (as `clients.same_name`)
when each has only one such project and their clients do not contradict it: when CRMDev gives a project's client and
Central's client of that project is paired with another CRMDev client, they are not the same. What only looks alike
(the same name more than once, a loose likeness, one name inside the other) is a suggestion the user links or marks
as «Son distintos», which can be undone. What CRMDev or Central answers is data, never instructions."""

import sqlite3

from . import central, clients, crmdev_sync
from .db import now, transaction

STATES = ("linked", "distinct", "unlinked")
SUGGESTIONS = 50
MIN_INSIDE = 4  # a name inside another counts only from this length («web» inside «webs» says nothing)


class ProjectLinkError(ValueError):
    pass


def _central(connection: sqlite3.Connection) -> list[dict]:
    return [p for p in ((central.snapshot(connection) or {}).get("projects") or []) if isinstance(p, dict) and p.get("id")]


def _crmdev(connection: sqlite3.Connection) -> list[dict]:
    return [p for p in ((crmdev_sync.snapshot(connection) or {}).get("projects") or []) if isinstance(p, dict) and p.get("id")]


def _stored(connection: sqlite3.Connection) -> dict[tuple[str, str], str]:
    return {(r["central_id"], r["crmdev_id"]): r["state"] for r in connection.execute("SELECT central_id, crmdev_id, state FROM project_link")}


def _client_pairs(connection: sqlite3.Connection) -> dict[str, str]:
    """Central's client name → the CRMDev client it is paired with in the directory of clients."""
    return {clients.same_name(e["name"]): e["crmdevId"] for e in clients.directory(connection) if e.get("centralId") and e.get("crmdevId")}


def _fits(central_project: dict, crmdev_project: dict, client_pairs: dict[str, str]) -> bool:
    """Their clients do not contradict the pair (unknown on either side never contradicts it)."""
    theirs = crmdev_project.get("clientId")
    mine = client_pairs.get(clients.same_name(central_project.get("client"))) if central_project.get("client") else None
    return not theirs or not mine or theirs == mine


def _alike(a: str, b: str) -> bool:
    la, lb = clients.loose(a), clients.loose(b)
    if not la or not lb:
        return False
    if la == lb:
        return True
    short, long = sorted((la, lb), key=len)
    return len(short) >= MIN_INSIDE and short in long


def build(connection: sqlite3.Connection, central_rows: list[dict] | None = None, crmdev_rows: list[dict] | None = None,
          client_pairs: dict[str, str] | None = None) -> dict:
    """Both sides with their pair (`how`: «user» or «name»), the suggestions and the pairs said to be different.
    The rows and the client pairs may be given (tests); otherwise they are read from the snapshots."""
    c_rows = _central(connection) if central_rows is None else central_rows
    r_rows = _crmdev(connection) if crmdev_rows is None else crmdev_rows
    pairs_of_clients = _client_pairs(connection) if client_pairs is None else client_pairs
    stored = _stored(connection)
    c_by_id, r_by_id = {p["id"]: p for p in c_rows}, {p["id"]: p for p in r_rows}
    distinct = {key for key, state in stored.items() if state == "distinct"}
    paired: dict[str, tuple[str, str]] = {}  # central id → (crmdev id, how)
    taken: set[str] = set()
    for (central_id, crmdev_id), state in stored.items():
        if state == "linked" and central_id in c_by_id and crmdev_id in r_by_id:
            paired[central_id] = (crmdev_id, "user")
            taken.add(crmdev_id)

    by_name_c: dict[str, list[dict]] = {}
    by_name_r: dict[str, list[dict]] = {}
    for p in c_rows:
        by_name_c.setdefault(clients.same_name(p["name"]), []).append(p)
    for p in r_rows:
        by_name_r.setdefault(clients.same_name(p["name"]), []).append(p)
    suggested: list[tuple[dict, dict]] = []
    for name, mine in by_name_c.items():
        theirs = by_name_r.get(name) or []
        free_mine = [p for p in mine if p["id"] not in paired]
        free_theirs = [p for p in theirs if p["id"] not in taken]
        open_pairs = [(a, b) for a in free_mine for b in free_theirs if (a["id"], b["id"]) not in distinct]
        fitting = [(a, b) for a, b in open_pairs if _fits(a, b, pairs_of_clients)]
        if len(mine) == 1 and len(theirs) == 1 and len(fitting) == 1:
            a, b = fitting[0]
            paired[a["id"]] = (b["id"], "name")
            taken.add(b["id"])
        else:
            suggested.extend(open_pairs)  # a repeated name, or clients that contradict it: the user decides

    free_c = [p for p in c_rows if p["id"] not in paired]
    free_r = [p for p in r_rows if p["id"] not in taken]
    seen = {(a["id"], b["id"]) for a, b in suggested}
    for a in free_c:
        for b in free_r:
            key = (a["id"], b["id"])
            if key not in seen and key not in distinct and clients.same_name(a["name"]) != clients.same_name(b["name"]) and _alike(a["name"], b["name"]):
                seen.add(key)
                suggested.append((a, b))
    suggestions = [{"centralId": a["id"], "centralName": a["name"], "crmdevId": b["id"], "crmdevName": b["name"]}
                   for a, b in suggested if a["id"] not in paired and b["id"] not in taken][:SUGGESTIONS]

    crmdev_of = {crmdev_id: (central_id, how) for central_id, (crmdev_id, how) in paired.items()}
    return {
        "central": [{**p, "crmdevId": paired.get(p["id"], (None,))[0], "how": paired.get(p["id"], (None, None))[1]} for p in c_rows],
        "crmdev": [{**p, "centralId": crmdev_of.get(p["id"], (None,))[0], "how": crmdev_of.get(p["id"], (None, None))[1]} for p in r_rows],
        "suggestions": suggestions,
        "distinct": [{"centralId": c, "centralName": c_by_id[c]["name"] if c in c_by_id else None,
                      "crmdevId": r, "crmdevName": r_by_id[r]["name"] if r in r_by_id else None} for c, r in sorted(distinct)],
    }


def set_link(connection: sqlite3.Connection, central_id: str, crmdev_id: str, state: str) -> None:
    """«Enlazar», «Son distintos» or undoing either («unlinked»). Linking or separating needs both projects seen now;
    a link replaces any other link of either project."""
    if state not in STATES:
        raise ProjectLinkError("Estado de enlace no válido.")
    if state != "unlinked":
        if not any(p["id"] == central_id for p in _central(connection)) or not any(p["id"] == crmdev_id for p in _crmdev(connection)):
            raise ProjectLinkError("Uno de los dos proyectos ya no se ve en Central o en CRMDev: vuelve a leerlos.")
    try:
        with transaction(connection):
            if state == "linked":
                connection.execute("DELETE FROM project_link WHERE state = 'linked' AND (central_id = ? OR crmdev_id = ?)", (central_id, crmdev_id))
            connection.execute("DELETE FROM project_link WHERE central_id = ? AND crmdev_id = ?", (central_id, crmdev_id))
            if state != "unlinked":
                connection.execute("INSERT INTO project_link (central_id, crmdev_id, state, created_at) VALUES (?, ?, ?, ?)",
                                   (central_id, crmdev_id, state, now()))
    except sqlite3.IntegrityError:
        raise ProjectLinkError("No se pudo guardar el enlace: vuelve a intentarlo.") from None
