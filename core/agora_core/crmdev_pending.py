"""«Pendiente en CRMDev»: what Central has and CRMDev lacks or has otherwise (user's decision, 20/11/2026: Central is
the source and CRMDev follows it, never the other way). Only reads the directory of clients (`clients.directory`, which
already joins both CRMs) and the pairs of projects (`project_links.build`); nothing is sent nor changed here.

Each warning has a stable `key` and a `signature` (a hash of what it shows). «Descartar» keeps both: the warning stays
hidden until its signature changes (something changed on either side). Kinds:
- `client_missing`: a client of Central with no client in CRMDev (neither its record nor people of its company).
- `contact_missing`: a client of Central in CRMDev only through people of its company, or with no address there, whose
  contact address is in none of them. The address is never in the warning: it only says it is missing.
- `client_changed`: a client in both with different name, company or address (an address only says that it differs).
- `crmdev_only`: a client of CRMDev that is not in Central (made by hand there): to be created in Central.
- `project_missing`: a project of Central (not archived) paired with none of CRMDev's; `clientInCrmdev` says whether
  its client is already in CRMDev (else it is sent without client unless the client goes first).
- `project_changed`: a pair of projects with a different name, a state that does not match or another client.
Each warning says the organization of CRMDev it is about (`org`, and `orgFrom`: `link`, `chosen` or `client`, see
`crmdev_orgs_assign`); a client or project still missing with none chosen has `org` None («Sin organización»).
Only while both are sources: Central's module on and read, CRMDev's on and connected. What either answers is data."""

import hashlib
import json
import re
import sqlite3

from . import central, clients, crmdev_orgs, crmdev_orgs_assign, crmdev_sync, project_links
from .db import now, transaction

KINDS = ("client_missing", "contact_missing", "client_changed", "crmdev_only", "project_missing", "project_changed")
KEY = re.compile(r"^(?:%s)(?::[A-Za-z0-9_-]{1,100}){1,2}$" % "|".join(KINDS))
SIGNATURE = re.compile(r"^[0-9a-f]{64}$")
# The state a project of Central has in CRMDev: what is sent when it is created or changed, and the states of CRMDev
# that already say the same (a project in maintenance may be in progress or completed there).
STATUS_TARGET = {"ACTIVE": "IN_PROGRESS", "MAINTENANCE": "IN_PROGRESS", "DORMANT": "ON_HOLD", "ARCHIVED": "COMPLETED"}
STATUS_ACCEPTED = {"ACTIVE": {"NOT_STARTED", "IN_PROGRESS"}, "MAINTENANCE": {"IN_PROGRESS", "COMPLETED"}, "DORMANT": {"ON_HOLD"},
                   "ARCHIVED": {"COMPLETED", "CANCELLED"}}
CENTRAL_STATUS = {"ACTIVE": "Activo", "MAINTENANCE": "Mantenimiento", "DORMANT": "En pausa", "ARCHIVED": "Archivado"}
CRMDEV_STATUS = {"NOT_STARTED": "Sin empezar", "IN_PROGRESS": "En curso", "ON_HOLD": "En pausa", "COMPLETED": "Completado", "CANCELLED": "Cancelado"}


class PendingError(ValueError):
    pass


def active(connection: sqlite3.Connection) -> bool:
    return central.snapshot(connection) is not None and bool(crmdev_sync.snapshots(connection))


def _signature(item: dict) -> str:
    shown = {k: v for k, v in item.items() if k not in ("key", "signature", "dismissed", "org", "orgFrom", "clientInCrmdev")}
    return hashlib.sha256(json.dumps(shown, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _client_items(entries: list[dict]) -> list[dict]:
    items = []
    for e in entries:
        central_id, crmdev_id = e.get("centralId"), e.get("crmdevId")
        if central_id and not crmdev_id and not e["contacts"]:
            items.append({"key": f"client_missing:{central_id}", "kind": "client_missing", "name": e["name"], "centralId": central_id,
                          "projects": len(e["projects"])})
        elif central_id and e["_centralEmail"] and e["_centralEmail"] not in e["contactEmails"] and not e["_crmdevEmail"]:
            items.append({"key": f"contact_missing:{central_id}", "kind": "contact_missing", "name": e["name"], "centralId": central_id,
                          "crmdevId": crmdev_id, "contacts": len(e["contacts"])})
        if central_id and crmdev_id and e["differences"]:
            changes = [{"field": d["field"], "label": d["label"], **({"missing": True} if d.get("missing") else {}),
                        **({} if d["field"] in clients.PRIVATE_FIELDS else {"central": e.get(d["field"]), "crmdev": d.get("crmdev")})}
                       for d in e["differences"]]
            items.append({"key": f"client_changed:{central_id}:{crmdev_id}", "kind": "client_changed", "name": e["name"], "centralId": central_id,
                          "crmdevId": crmdev_id, "changes": changes})
        if crmdev_id and not central_id:
            items.append({"key": f"crmdev_only:{crmdev_id}", "kind": "crmdev_only", "name": e["name"], "crmdevId": crmdev_id,
                          "localId": e.get("localId"), "status": e.get("crmdevStatus")})
    return items


def _project_items(pairs: dict, crmdev_client_of: dict[str, str]) -> list[dict]:
    items = []
    theirs = {p["id"]: p for p in pairs["crmdev"]}
    hinted = {}
    for s in pairs["suggestions"]:
        hinted.setdefault(s["centralId"], s["crmdevName"])
    for p in pairs["central"]:
        if p.get("status") == "ARCHIVED" and not p.get("crmdevId"):
            continue
        if not p.get("crmdevId"):
            items.append({"key": f"project_missing:{p['id']}", "kind": "project_missing", "name": p["name"], "centralId": p["id"],
                          "client": p.get("client"), "status": p.get("status"), "projectKind": p.get("kind"), "maybe": hinted.get(p["id"]),
                          "clientInCrmdev": bool(crmdev_client_of.get(clients.same_name(p["client"]))) if p.get("client") else None})
            continue
        other = theirs.get(p["crmdevId"]) or {}
        changes = []
        if clients.same_name(p["name"]) != clients.same_name(other.get("name")):
            changes.append({"field": "name", "label": "Nombre", "central": p["name"], "crmdev": other.get("name")})
        accepted = STATUS_ACCEPTED.get(p.get("status") or "")
        if accepted and other.get("status") and other["status"] not in accepted:
            changes.append({"field": "status", "label": "Estado", "central": CENTRAL_STATUS[p["status"]],
                            "crmdev": CRMDEV_STATUS.get(other["status"], other["status"])})
        wanted = crmdev_client_of.get(clients.same_name(p.get("client"))) if p.get("client") else None
        if wanted and other.get("clientId") and other["clientId"] != wanted:
            changes.append({"field": "client", "label": "Cliente", "central": p.get("client"), "crmdev": None})
        if changes:
            items.append({"key": f"project_changed:{p['id']}:{p['crmdevId']}", "kind": "project_changed", "name": p["name"],
                          "centralId": p["id"], "crmdevId": p["crmdevId"], "changes": changes})
    return items


def _place(connection: sqlite3.Connection, entries: list[dict], items: list[dict]) -> None:
    """Writes on each warning the organization it is about and where that comes from."""
    client_org = {r["id"]: r["org"] for r in crmdev_sync.rows(connection, "clients") if r.get("id")}
    project_org = {r["id"]: r["org"] for r in crmdev_sync.rows(connection, "projects") if r.get("id")}
    chosen = crmdev_orgs_assign.chosen(connection)
    of_client: dict[str, tuple[str | None, str | None]] = {}
    by_name: dict[str, tuple[str | None, str | None]] = {}
    for e in entries:
        central_id = e.get("centralId")
        if not central_id:
            continue
        linked = client_org.get(e["crmdevId"]) if e.get("crmdevId") else None
        if linked is None:
            among = {client_org.get(c["id"]) for c in e["contacts"]} - {None}
            linked = among.pop() if len(among) == 1 else None
        place = (linked, "link") if linked else (chosen[("client", central_id)], "chosen") if ("client", central_id) in chosen else (None, None)
        of_client[central_id] = by_name[clients.same_name(e["name"])] = place
    for item in items:
        kind = item["kind"]
        if kind in ("crmdev_only", "client_changed"):
            place = (client_org.get(item["crmdevId"]), "link")
        elif kind == "project_changed":
            place = (project_org.get(item["crmdevId"]), "link")
        elif kind in ("client_missing", "contact_missing"):
            place = of_client.get(item["centralId"], (None, None))
        elif ("project", item["centralId"]) in chosen:
            place = (chosen[("project", item["centralId"])], "chosen")
        else:
            org = by_name.get(clients.same_name(item.get("client")), (None, None))[0] if item.get("client") else None
            place = (org, "client" if org else None)
        item["org"], item["orgFrom"] = place if place[0] else (None, None)


def build(connection: sqlite3.Connection, include_dismissed: bool = False) -> dict:
    """The warnings (without the dismissed ones unless asked), their counts by kind and how many are dismissed."""
    if not active(connection):
        return {"active": False, "items": [], "counts": {k: 0 for k in KINDS}, "dismissed": 0, "truncated": False, "orgs": []}
    entries = clients.directory(connection)
    # Each side's own address (the entry's is Central's, else CRMDev's, else the one kept here).
    crmdev_emails = {c["id"]: c.get("email") for c in crmdev_sync.rows(connection, "clients") if c.get("id")}
    central_emails = {c.get("id"): c.get("email") for c in (central.snapshot(connection) or {}).get("clients") or []}
    for e in entries:
        e["_crmdevEmail"] = crmdev_emails.get(e["crmdevId"]) if e.get("crmdevId") else None
        e["_centralEmail"] = central_emails.get(e["centralId"]) if e.get("centralId") else None
    crmdev_client_of = {clients.same_name(e["name"]): e["crmdevId"] for e in entries if e.get("centralId") and e.get("crmdevId")}
    items = _client_items(entries) + _project_items(project_links.build(connection), crmdev_client_of)
    _place(connection, entries, items)
    stored = {r["key"]: r["signature"] for r in connection.execute("SELECT key, signature FROM crmdev_pending_dismissed")}
    shown, hidden = [], 0
    for item in items:
        item["signature"] = _signature(item)
        item["dismissed"] = stored.get(item["key"]) == item["signature"]
        hidden += item["dismissed"]
        if include_dismissed or not item["dismissed"]:
            shown.append(item)
    counts = {k: sum(1 for i in items if i["kind"] == k and not i["dismissed"]) for k in KINDS}
    return {"active": True, "items": shown, "counts": counts, "dismissed": hidden,
            "truncated": any(bool(s.get("truncated") or s.get("projectsTruncated")) for s in crmdev_sync.snapshots(connection).values()),
            "orgs": crmdev_orgs.orgs(connection)}


def dismiss(connection: sqlite3.Connection, key: str, signature: str | None) -> None:
    """«Descartar» (with the signature shown) or «Volver a mostrar» (`signature` None)."""
    if not KEY.fullmatch(key or ""):
        raise PendingError("Aviso no válido.")
    with transaction(connection):
        if signature is None:
            connection.execute("DELETE FROM crmdev_pending_dismissed WHERE key = ?", (key,))
            return
        if not SIGNATURE.fullmatch(signature):
            raise PendingError("Aviso no válido.")
        connection.execute("INSERT INTO crmdev_pending_dismissed (key, signature, created_at) VALUES (?, ?, ?) "
                           "ON CONFLICT (key) DO UPDATE SET signature = excluded.signature, created_at = excluded.created_at",
                           (key, signature, now()))
