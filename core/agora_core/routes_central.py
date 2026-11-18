"""HTTP routes of Central: its connection (URL and key, always reachable from Settings), its snapshot (clients and
servers, read-only) and its refresh every half hour. With the «Central» module off, the snapshot routes answer 404
and nothing is read in the background. The key is never returned: only whether there is one."""

import sqlite3
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import addons, central, central_api, modules
from .db import DB_NAME, connect
from .settings import Settings

REFRESH_SECONDS = 1800


class CentralHealth:
    def __init__(self):
        self.problem: str | None = None  # a failure, shown as a warning
        self.notice: str | None = None  # a setting worth saying once and quietly (a key that cannot read)


def _folder(connection: sqlite3.Connection) -> Path | None:
    path = addons.config(connection, "central").get("path")
    return Path(path) if path and addons.recognised("central", Path(path)) else None


class ConnectionIn(BaseModel):
    # Checked in the route, not here: a validation error would echo the key back. A missing key keeps the saved one.
    url: object = None
    key: object = None


NOT_CONFIGURED = "Central no está conectado: conéctalo en Ajustes › Central."
OFF = "El módulo Central está apagado."
NEW_ORIGIN = "Para otra dirección (otro servidor, puerto o esquema), escribe otra vez la clave: la guardada no viaja a un servidor nuevo."


def read_now(connection: sqlite3.Connection, secrets, health: CentralHealth) -> tuple[dict | None, str | None]:
    """Reads Central from its source: the API when connected, else the old folder. A key without «lectura» is
    not a failure: the folder is read when there is one, and otherwise nothing, with a quiet notice."""
    folder = _folder(connection)
    origin = central.source(connection, secrets, folder)
    if origin is None:
        return None, None
    way = "http" if isinstance(origin, central_api.Connection) else "stdio"
    try:
        data = central.refresh(connection, origin)
        health.notice = None
    except central.NoReadingError as error:
        health.notice = str(error)
        if folder is None:
            health.problem = None
            return central.snapshot(connection), way
        data, way = central.refresh(connection, folder), "stdio"
    health.problem = None
    return data, way


def central_worker(settings: Settings, stop: threading.Event, health: CentralHealth, secrets) -> None:
    stop.wait(30)
    while not stop.is_set():
        try:
            connection = connect(settings.data_dir / DB_NAME)
            try:
                read_now(connection, secrets, health)
            finally:
                connection.close()
        except Exception as error:  # noqa: BLE001 - the worker survives anything and says so
            if health.problem is None:
                print(f"AgoraOne núcleo: lectura de Central en pausa ({type(error).__name__})", file=sys.stderr)
            health.problem = str(error)[:200] if isinstance(error, central.CentralError) else "No se pudo leer Central."
        stop.wait(REFRESH_SECONDS)


def central_router(settings: Settings, health: CentralHealth, secrets) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    async def db(work):
        def task():
            with database() as connection:
                return work(connection)
        return await run_in_threadpool(task)

    def public(data: dict | None) -> dict | None:
        """What the screen needs: no client's address, phone or tax id leaves the core here."""
        if not data:
            return data
        return {**data, "clients": [{k: v for k, v in c.items() if k not in ("email", "phone", "taxId")} for c in data["clients"]]}

    def transport(connection) -> str | None:
        if central_api.connection_of(connection, secrets):
            return "http"
        return "stdio" if _folder(connection) else None

    def off(connection) -> bool:
        return not modules.state(connection)["central"]

    @router.get("/central")
    async def get_central():
        found = await db(lambda c: None if off(c) else (central.snapshot(c), transport(c)))
        if found is None:
            return JSONResponse({"error": OFF}, status_code=404)
        data, way = found
        return {"configured": way is not None, "transport": way, "snapshot": public(data), "problem": health.problem, "notice": health.notice}

    @router.post("/central/refresh")
    async def refresh():
        def work(connection):
            if off(connection):
                return None
            data, way = read_now(connection, secrets, health)
            if way is None:
                raise central.CentralError(NOT_CONFIGURED)
            return data, way
        try:
            found = await db(work)
        except central.CentralError as error:
            health.problem = str(error)
            return JSONResponse({"error": str(error)}, status_code=502)
        if found is None:
            return JSONResponse({"error": OFF}, status_code=404)
        health.problem = None
        return {"configured": True, "transport": found[1], "snapshot": public(found[0]), "problem": None, "notice": health.notice}

    # The connection: available with the module off, so Settings can always connect or disconnect.
    async def described() -> dict:
        def work(connection):
            url = central_api.saved_url(connection)
            try:
                has_key, store = central_api.read_key(secrets) is not None, None
            except central_api.CentralApiError as error:
                has_key, store = False, str(error)
            return {"url": url, "hasKey": has_key, "storeProblem": store, "legacyFolder": _folder(connection) is not None,
                    "transport": "http" if url and has_key else "stdio" if _folder(connection) else None, "suggestedUrl": central_api.SUGGESTED_URL}
        return await db(work)

    def problem(status: int, message: str) -> JSONResponse:
        return JSONResponse({"error": message}, status_code=status)

    @router.get("/central/connection")
    async def get_connection():
        return await described()

    @router.put("/central/connection")
    async def put_connection(body: ConnectionIn):
        url_problem = central_api.url_problem(body.url)
        if url_problem:
            return problem(422, url_problem)
        if body.key is None and not await db(lambda c: central_api.same_origin(central_api.saved_url(c), body.url)):
            return problem(422, NEW_ORIGIN)
        if body.key is not None:
            key_problem = central_api.key_problem(body.key)
            if key_problem:
                return problem(422, key_problem)
            try:
                await run_in_threadpool(central_api.write_key, secrets, body.key.strip())
            except central_api.CentralApiError as error:
                return problem(503, str(error))
        def store(connection):
            central_api.save_url(connection, body.url)
            modules.apply(connection)  # a first connection turns on the modules that follow Central
        await db(store)
        return await described()

    @router.delete("/central/connection")
    async def delete_connection():
        """Forgets the key (the URL stays, it is not secret): Central is no longer read over HTTP."""
        try:
            await run_in_threadpool(central_api.write_key, secrets, None)
        except central_api.CentralApiError as error:
            return problem(503, str(error))
        return await described()

    @router.post("/central/connection/test")
    async def test_connection(body: ConnectionIn | None = None):
        """Asks Central's `estado` with the URL and key typed (not saved yet) or, when missing, the saved ones."""
        body = body or ConnectionIn()
        if body.url is not None and central_api.url_problem(body.url):
            return problem(422, central_api.url_problem(body.url))
        if body.key is not None and central_api.key_problem(body.key):
            return problem(422, central_api.key_problem(body.key))
        def work(connection):
            saved = central_api.saved_url(connection)
            url = central_api.normalize_url(body.url) if body.url is not None else saved
            if not isinstance(body.key, str) and url and not central_api.same_origin(saved, url):
                raise central_api.CentralApiError("config", NEW_ORIGIN)  # the saved key never goes to another server
            key = body.key.strip() if isinstance(body.key, str) else central_api.read_key(secrets)
            if not url or not key:
                raise central_api.CentralApiError("config", "Escribe la dirección y la clave de Central.")
            return central_api.status(central_api.Connection(url, key))
        try:
            return await db(work)
        except central_api.CentralApiError as error:
            return JSONResponse({"error": str(error), "status": error.status}, status_code=422 if error.status == "config" else 502)

    return router
