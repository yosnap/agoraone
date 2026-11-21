"""A task or a ticket of CRMDev as the source of a launch in Orca (user's decision, 20/11/2026). Only when its CRMDev
project is linked with the Central project chosen (`project_links`), so the work goes to that project's repository and
never to another one. The record is read from CRMDev through the closed list (`list_tasks`, `list_tickets`, the 60 s
cache) of its organization of CRMDev, with that organization's key, never kept; the project must be of that same
organization. What goes to the agent: its title, state, priority, category and description, without lines that
look like keys, links or numbers, fenced as data by `orca_launch.prompt`; never the address nor the name of who opened
a ticket. CRMDev's text is data, never instructions."""

import sqlite3

from . import central, crmdev_api, crmdev_orgs, crmdev_sync, modules, project_links
from .crmdev_shapes import project_id
from .web_api import WebApiError

KINDS = {"crmdev_task": ("list_tasks", "Tarea"), "crmdev_ticket": ("list_tickets", "Ticket")}
WHAT = {"crmdev_task": "una tarea de CRMDev", "crmdev_ticket": "un ticket de CRMDev"}


class SourceError(ValueError):
    pass


def load(connection: sqlite3.Connection, secrets, kind: str, item_id: str, client: str, project: str, org: str | None = None) -> dict:
    """The record as it goes to the agent, after checking its project is linked with the Central one chosen."""
    if kind not in KINDS or not isinstance(item_id, str) or not crmdev_api.ID.fullmatch(item_id):
        raise SourceError("Origen de CRMDev no válido.")
    if not modules.state(connection)["crmdev"] or not crmdev_sync.active(connection):
        raise SourceError("El módulo CRMDev está apagado o sin conectar.")
    if org is not None and not crmdev_orgs.known(connection, org):
        raise SourceError("Esa organización de CRMDev ya no está.")
    org = org or crmdev_orgs.default(connection)
    target = crmdev_orgs.connection_of(connection, secrets, org)
    if target is None:
        raise SourceError("Conecta CRMDev en Conectores › CRMDev.")
    tool, noun = KINDS[kind]
    try:
        rows = crmdev_api.call(target, tool, {"limit": crmdev_api.MAX_ROWS})
    except WebApiError as error:
        raise SourceError(str(error)) from None
    row = next((r for r in rows if isinstance(r, dict) and r.get("id") == item_id), None) if isinstance(rows, list) else None
    if row is None:
        raise SourceError(f"{noun} ya no está entre los {crmdev_api.MAX_ROWS} más recientes de CRMDev.")
    crmdev_project = project_id(row)
    links = project_links.build(connection)
    central_id = next((p["centralId"] for p in links["crmdev"] if p["id"] == crmdev_project and p.get("org") == org), None) if crmdev_project else None
    mine = next((p for p in (central.snapshot(connection) or {}).get("projects") or [] if p.get("id") == central_id), None) if central_id else None
    if mine is None or mine.get("name") != project or (mine.get("client") or "") != (client or ""):
        raise SourceError(f"{noun} es de un proyecto de CRMDev que no está enlazado con «{project}» de Central: enlázalos en la ficha del proyecto.")
    title = " ".join(str(row.get("title") or "").split())[:300] or "(sin título)"
    facts = [f"{noun} de CRMDev: {title}"]
    for key, label in (("status", "Estado"), ("priority", "Prioridad"), ("category", "Categoría"), ("dueDate", "Fecha límite")):
        if isinstance(row.get(key), str) and row[key].strip():
            facts.append(f"{label}: {row[key].strip()[:40]}")
    description = row.get("description") if isinstance(row.get("description"), str) else ""
    return {"kind": kind, "id": item_id, "org": org, "label": f"{noun} de CRMDev «{title[:120]}»", "text": "\n".join(facts) + "\n\n" + description.strip()}
