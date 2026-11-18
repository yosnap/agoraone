"""HTTP routes of the «Central» section: `GET /central/views/{view}` and `GET /central/views/{view}/{id}`, read live
from Central's API with the saved connection. `view` comes from a closed list that maps to a fixed path of the API
and `id` must look like a cuid, so the screen can never make the core ask Central for another path. Read-only.

With the «Central» module off every route answers 404 and nothing is asked. Without an HTTP connection (no URL or no
key) the answer is 409 `not_connected`, which the screen shows as «Conecta Central». A failure of Central is a 502
in plain words, never with the key nor Central's address; for clients the last snapshot is answered instead, marked
with the time it was read."""

import sqlite3
import time
from contextlib import contextmanager

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import central, central_api, central_views, modules
from .db import DB_NAME, connect
from .settings import Settings

OFF = "El módulo Central está apagado."
NOT_CONNECTED = "Central no está conectado por su dirección y clave: conéctalo en Ajustes › Central."
NO_VIEW = "Esa vista de Central no existe."
BAD_ID = "El identificador no es válido."
STATUS_CODES = {"forbidden": 403, "not_found": 404}
SUMMARY_SECONDS = 15  # the summary, which takes several requests, is kept this long


def central_views_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()
    summaries: dict[str, tuple[float, dict]] = {}  # per Central address: when it was read and what

    def read_list(target: central_api.Connection, view: str, query: dict) -> dict:
        if view != "resumen":
            return central_views.read_list(target, view, query)
        kept = summaries.get(target.url)
        if kept and time.monotonic() - kept[0] < SUMMARY_SECONDS:
            return kept[1]
        data = central_views.read_list(target, view, query)
        summaries[target.url] = (time.monotonic(), data)
        return data

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def problem(status: int, message: str, kind: str) -> JSONResponse:
        return JSONResponse({"error": message, "status": kind}, status_code=status)

    def prepare(connection: sqlite3.Connection) -> tuple[central_api.Connection | None, dict | None] | None:
        """None with the module off; else the HTTP connection (or None) and the stored snapshot."""
        if not modules.state(connection)["central"]:
            return None
        return central_api.connection_of(connection, secrets), central.stored(connection)

    def failed(error: central_api.CentralApiError) -> JSONResponse:
        # The messages of central_api are fixed sentences (Central's own reason has the key scrubbed): no URL nor key.
        return problem(STATUS_CODES.get(error.status, 502), str(error), error.status)

    async def answer(check, work, stored):
        """Module off → 404; a request out of shape → 404/422; no connection → 409; Central failing → 502 or, when
        there is one, the snapshot's version marked with the time it was read."""
        found = await run_in_threadpool(_with, database, prepare)
        if found is None:
            return problem(404, OFF, "off")
        refused = check()
        if refused is not None:
            return refused
        target, snapshot = found
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")
        try:
            return await run_in_threadpool(work, target)
        except central_api.CentralApiError as error:
            kept = None if error.status in ("forbidden", "not_found") else stored(snapshot)
            if kept is None:
                return failed(error)
            return {**kept, "fallback": {"readAt": (snapshot or {}).get("fetchedAt"), "problem": str(error)}}

    @router.get("/central/views/{view}")
    async def list_view(view: str, request: Request):
        query: dict = {}

        def check():
            if view not in central_views.VIEWS:
                return problem(404, NO_VIEW, "not_found")
            try:
                query.update(central_views.params_of(view, dict(request.query_params)))
            except central_views.ViewError as error:
                return problem(422, str(error), "invalid")
            return None
        return await answer(check, lambda target: read_list(target, view, query),
                            lambda snapshot: central_views.stored_clients(snapshot) if view == "clientes" and not query else None)

    # «path» so that an id with «/» reaches the check (422) instead of missing the route.
    @router.get("/central/views/{view}/{item:path}")
    async def item_view(view: str, item: str, request: Request):
        def check():
            if view not in central_views.ITEM_PATHS:
                return problem(404, NO_VIEW, "not_found")
            if not central_views.ID.fullmatch(item) or request.query_params:
                return problem(422, BAD_ID, "invalid")
            return None
        return await answer(check, lambda target: central_views.read_item(target, view, item),
                            lambda snapshot: central_views.stored_client(snapshot, item) if view == "clientes" else None)

    return router


def _with(database, work):
    with database() as connection:
        return work(connection)

