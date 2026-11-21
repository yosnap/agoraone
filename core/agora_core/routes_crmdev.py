"""HTTP routes of the «CRMDev» section, read live from CRMDev's REST API with the saved connection, read-only:
`GET /crmdev/views/{view}` (proyectos, tareas, tickets, clientes and miembros, with the filters `estado`, `proyecto`
for tasks and `cliente` for tickets), `GET /crmdev/proyectos/{id}/horas` and `GET /crmdev/clientes/{id}` (a client's record
with its address, taken from the same list and filter, since CRMDev has no read by id). Every answer says when CRMDev
gave it (`readAt`); `?org=o2` reads that organization of CRMDev with its own key (the first one when none is
said; an organization AgoraOne does not know → 409 `no_org`); `?fresco=1` («Volver a leer») asks CRMDev now instead of the 60 s cache, still waiting after a 429. Each view maps to one tool of the
closed list in `crmdev_api`, which checks the arguments before anything leaves; lists are the 100 most recent
(members: the 100 who joined first, the order CRMDev gives them).

With the «CRMDev» module off every route answers 404 and nothing is asked. Without a connection (no URL or no key)
the answer is 409 `not_connected`. A failure of CRMDev is said in plain words, never with the key nor its address.
What comes back is data: it is shown as text, not stored, not sent to any model and it triggers nothing."""

import re
from contextlib import contextmanager
from datetime import UTC, datetime

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import crmdev_api, crmdev_orgs, crmdev_shapes, crmdev_sync, modules, web_api
from .db import DB_NAME, connect
from .settings import Settings

OFF = "El módulo CRMDev está apagado."
NOT_CONNECTED = "Conecta CRMDev en Conectores › CRMDev."
NO_VIEW = "Esa vista de CRMDev no existe."
BAD_FILTER = "Ese filtro no existe en esta vista de CRMDev."
BAD_ID = "El identificador no es válido."
NO_ORG = "Esa organización de CRMDev ya no está: elige otra."
ORG = re.compile(r"^o[1-9][0-9]{0,3}$")
NO_CLIENT = "Ese cliente no está entre los 100 más recientes de CRMDev: míralo en CRMDev."
STATUS_CODES = {"forbidden": 403, "not_found": 404, "invalid": 422, "busy": 429, "config": 409}
# view → (tool, its shape, the filters it takes: query name → argument of the tool)
VIEWS = {
    "proyectos": ("list_projects", crmdev_shapes.shape_project, {"estado": "status"}),
    "tareas": ("list_tasks", crmdev_shapes.shape_task, {"estado": "status", "proyecto": "projectId"}),
    "tickets": ("list_tickets", crmdev_shapes.shape_ticket, {"estado": "status", "cliente": "clientId"}),
    "clientes": ("list_clients", crmdev_shapes.shape_client, {"estado": "status"}),
    "miembros": ("list_members", crmdev_shapes.shape_member, {}),
}
# Which rows a full list holds: CRMDev sorts members by when they joined, everything else newest first.
ORDER = {"miembros": "primeros"}


def crmdev_router(settings: Settings, secrets, health: crmdev_sync.CrmdevHealth | None = None) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def problem(status: int, message: str, kind: str) -> JSONResponse:
        return JSONResponse({"error": message, "status": kind}, status_code=status)

    def prepare(org: str | None) -> tuple[bool, bool, web_api.Connection | None]:
        with database() as connection:
            if not modules.state(connection)["crmdev"]:
                return False, False, None
            if org is not None and not crmdev_orgs.known(connection, org):
                return True, False, None
            return True, True, crmdev_orgs.connection_of(connection, secrets, org)

    async def answer(tool: str, arguments: dict, shape, fresh: bool = False, org: str | None = None):
        on, known, target = await run_in_threadpool(prepare, org)
        if not on:
            return problem(404, OFF, "off")
        if not known:
            return problem(409, NO_ORG, "no_org")
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")
        try:
            data, at = await run_in_threadpool(crmdev_api.call_at, target, tool, arguments, fresh)
            shaped = shape(data)
            return {**shaped, "readAt": _iso(at)} if isinstance(shaped, dict) else shaped
        except web_api.WebApiError as error:
            # Fixed sentences of web_api/crmdev_api (CRMDev's own reason has the key scrubbed): no URL nor key.
            return problem(STATUS_CODES.get(error.status, 502), str(error), error.status)

    @router.get("/crmdev/views/{view}")
    async def list_view(view: str, request: Request):
        if view not in VIEWS:
            # Checked before the module, so an unknown view never reveals whether CRMDev is connected.
            return problem(404, NO_VIEW, "not_found")
        tool, shape, filters = VIEWS[view]
        split = _split_fresh(request)
        if split is None or any(name not in filters for name in split[0]):
            return problem(422, BAD_FILTER, "invalid")
        query, fresh, org = split
        arguments = {filters[name]: value for name, value in query.items()}
        try:  # refused here, with the module on or off, so nothing out of shape ever reaches `call`
            crmdev_api.checked_arguments(tool, arguments)
        except web_api.WebApiError as error:
            return problem(422, str(error), "invalid")
        return await answer(tool, {**arguments, "limit": crmdev_api.MAX_ROWS}, lambda data: _page(shape, data, ORDER.get(view, "recientes")), fresh, org)

    # «path» so that an id with «/» reaches the check (422) instead of missing the route.
    @router.get("/crmdev/proyectos/{project:path}/horas")
    async def hours(project: str, request: Request):
        split = _split_fresh(request)
        if not crmdev_api.ID.fullmatch(project) or split is None or split[0]:
            return problem(422, BAD_ID, "invalid")
        return await answer("get_project_time_report", {"projectId": project}, crmdev_shapes.shape_hours, split[1], split[2])

    # The only answer with a client's address: its record, which the screen hides (and does not ask) in discreet mode.
    # Same tool and arguments as the list of clients on screen (with its `estado`), so it shares its cache instead of
    # asking CRMDev again, and a client of that list is always found.
    @router.get("/crmdev/clientes/{client:path}")
    async def client_record(client: str, request: Request):
        split = _split_fresh(request)
        if not crmdev_api.ID.fullmatch(client) or split is None or any(name != "estado" for name in split[0]):
            return problem(422, BAD_ID if split is not None else BAD_FILTER, "invalid")
        query, fresh, org = split
        arguments = {"status": query["estado"]} if "estado" in query else {}
        try:
            crmdev_api.checked_arguments("list_clients", arguments)
        except web_api.WebApiError as error:
            return problem(422, str(error), "invalid")

        def record(data: object):
            found = [row for row in crmdev_shapes.shape_list(lambda row: row, data) if crmdev_shapes.row_id(row.get("id")) == client]
            if not found:
                return problem(404, NO_CLIENT, "not_found")
            return crmdev_shapes.shape_client(found[0], contact=True)

        return await answer("list_clients", {**arguments, "limit": crmdev_api.MAX_ROWS}, record, fresh, org)

    # «Actualizar» of the clients the directory uses (Trabajos › Clientes and the CRMDev section): CRMDev is read now.
    @router.post("/crmdev/clients/refresh")
    async def refresh_clients():
        def work():
            with database() as connection:
                if not modules.state(connection)["crmdev"]:
                    return problem(404, OFF, "off")
                if crmdev_api.connection_of(connection, secrets) is None:
                    return problem(409, NOT_CONNECTED, "not_connected")
                # Every organization whose key is saved, one after another (a failing one is said, the others are read).
                read = crmdev_sync.read_now(connection, secrets, health or crmdev_sync.CrmdevHealth())
                every = crmdev_sync.snapshots(connection)
            if read is None:
                return problem(409, NOT_CONNECTED, "not_connected")
            return {"count": sum(len(s["clients"]) for s in every.values()), "fetchedAt": read["fetchedAt"],
                    "truncated": any(s.get("truncated") for s in every.values()), "organizations": len(every)}
        try:
            return await run_in_threadpool(work)
        except web_api.WebApiError as error:
            if health is not None and error.status != "busy":
                health.problem = str(error)[:200]
            return problem(STATUS_CODES.get(error.status, 502), str(error), error.status)

    return router


def _iso(at: float) -> str:
    return datetime.fromtimestamp(at, UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _split_fresh(request: Request) -> tuple[dict, bool, str | None] | None:
    """The query without `fresco` nor `org`, whether it asks for a fresh reading and the organization; None when a name
    repeats, `fresco` is anything but «1» or `org` is not an id of an organization."""
    items = request.query_params.multi_items()
    query = dict(items)
    if len(items) != len(query):
        return None
    fresh = query.pop("fresco", None)
    org = query.pop("org", None)
    if fresh not in (None, "1") or (org is not None and not ORG.fullmatch(org)):
        return None
    return query, fresh == "1", org


def _page(shape, data: object, order: str) -> dict:
    """The reduced rows; `more` when the list is full, since CRMDev has no pages and the rest is only seen there.
    `order` says which rows a full list holds: the most recent ones or (members) the first ones."""
    items = crmdev_shapes.shape_list(shape, data)
    return {"items": items, "limit": crmdev_api.MAX_ROWS, "more": len(items) >= crmdev_api.MAX_ROWS, "order": order}
