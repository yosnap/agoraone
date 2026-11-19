"""HTTP routes of the «CRMDev» section, read live from CRMDev's REST API with the saved connection, read-only:
`GET /crmdev/views/{view}` (proyectos, tareas, tickets, clientes and miembros, with the filters `estado`, `proyecto`
for tasks and `cliente` for tickets), `GET /crmdev/proyectos/{id}/horas` and `GET /crmdev/clientes/{id}` (a client's record
with its address, taken from the same list, since CRMDev has no read by id). Each view maps to one tool of the
closed list in `crmdev_api`, which checks the arguments before anything leaves; lists are the 100 most recent
(members: the 100 who joined first, the order CRMDev gives them).

With the «CRMDev» module off every route answers 404 and nothing is asked. Without a connection (no URL or no key)
the answer is 409 `not_connected`. A failure of CRMDev is said in plain words, never with the key nor its address.
What comes back is data: it is shown as text, not stored, not sent to any model and it triggers nothing."""

from contextlib import contextmanager

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import crmdev_api, crmdev_shapes, modules, web_api
from .db import DB_NAME, connect
from .settings import Settings

OFF = "El módulo CRMDev está apagado."
NOT_CONNECTED = "Conecta CRMDev en Conectores › CRMDev."
NO_VIEW = "Esa vista de CRMDev no existe."
BAD_FILTER = "Ese filtro no existe en esta vista de CRMDev."
BAD_ID = "El identificador no es válido."
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


def crmdev_router(settings: Settings, secrets) -> APIRouter:
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

    def prepare() -> tuple[bool, web_api.Connection | None]:
        with database() as connection:
            if not modules.state(connection)["crmdev"]:
                return False, None
            return True, crmdev_api.connection_of(connection, secrets)

    async def answer(tool: str, arguments: dict, shape):
        on, target = await run_in_threadpool(prepare)
        if not on:
            return problem(404, OFF, "off")
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")
        try:
            data = await run_in_threadpool(crmdev_api.call, target, tool, arguments)
            return shape(data)
        except web_api.WebApiError as error:
            # Fixed sentences of web_api/crmdev_api (CRMDev's own reason has the key scrubbed): no URL nor key.
            return problem(STATUS_CODES.get(error.status, 502), str(error), error.status)

    @router.get("/crmdev/views/{view}")
    async def list_view(view: str, request: Request):
        if view not in VIEWS:
            # Checked before the module, so an unknown view never reveals whether CRMDev is connected.
            return problem(404, NO_VIEW, "not_found")
        tool, shape, filters = VIEWS[view]
        query = dict(request.query_params)
        if any(name not in filters for name in query) or len(request.query_params.multi_items()) != len(query):
            return problem(422, BAD_FILTER, "invalid")
        arguments = {filters[name]: value for name, value in query.items()}
        try:  # refused here, with the module on or off, so nothing out of shape ever reaches `call`
            crmdev_api.checked_arguments(tool, arguments)
        except web_api.WebApiError as error:
            return problem(422, str(error), "invalid")
        return await answer(tool, {**arguments, "limit": crmdev_api.MAX_ROWS}, lambda data: _page(shape, data, ORDER.get(view, "recientes")))

    # «path» so that an id with «/» reaches the check (422) instead of missing the route.
    @router.get("/crmdev/proyectos/{project:path}/horas")
    async def hours(project: str, request: Request):
        if not crmdev_api.ID.fullmatch(project) or request.query_params:
            return problem(422, BAD_ID, "invalid")
        return await answer("get_project_time_report", {"projectId": project}, crmdev_shapes.shape_hours)

    # The only answer with a client's address: its record, which the screen hides (and does not ask) in discreet mode.
    # Same tool and arguments as the list of clients, so it shares its cache instead of asking CRMDev again.
    @router.get("/crmdev/clientes/{client:path}")
    async def client_record(client: str, request: Request):
        if not crmdev_api.ID.fullmatch(client) or request.query_params:
            return problem(422, BAD_ID, "invalid")

        def record(data: object):
            found = [row for row in crmdev_shapes.shape_list(lambda row: row, data) if row.get("id") == client]
            if not found:
                return problem(404, NO_CLIENT, "not_found")
            return crmdev_shapes.shape_client(found[0], contact=True)

        return await answer("list_clients", {"limit": crmdev_api.MAX_ROWS}, record)

    return router


def _page(shape, data: object, order: str) -> dict:
    """The reduced rows; `more` when the list is full, since CRMDev has no pages and the rest is only seen there.
    `order` says which rows a full list holds: the most recent ones or (members) the first ones."""
    items = crmdev_shapes.shape_list(shape, data)
    return {"items": items, "limit": crmdev_api.MAX_ROWS, "more": len(items) >= crmdev_api.MAX_ROWS, "order": order}
