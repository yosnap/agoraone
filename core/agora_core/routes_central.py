"""HTTP routes of Central: its snapshot (clients and servers, read-only) and its refresh every half hour. Its
connection (URL and key) is made through the connectors (`routes_connectors.py`). With the «Central» module off,
these routes answer 404 and nothing is read in the background."""

import sqlite3
import sys
import threading
from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import central, central_api, modules
from .db import DB_NAME, connect
from .settings import Settings

REFRESH_SECONDS = 1800


class CentralHealth:
    def __init__(self):
        self.problem: str | None = None  # a failure, shown as a warning
        self.notice: str | None = None  # a setting worth saying once and quietly (a key that cannot read)


NOT_CONFIGURED = "Central no está conectado: conéctalo en Ajustes › Central."
OFF = "El módulo Central está apagado."


def read_now(connection: sqlite3.Connection, secrets, health: CentralHealth) -> tuple[dict | None, str | None]:
    """Reads Central through its API when connected; otherwise nothing. A key without «lectura» is not a failure:
    the stored snapshot stays, with a quiet notice."""
    origin = central.source(connection, secrets)
    if origin is None:
        return None, None
    try:
        data = central.refresh(connection, origin)
        health.notice = None
        if central.legacy(connection):
            central.forget_legacy(connection)  # read through the API: the old folder setting is no longer needed
    except central.NoReadingError as error:
        health.notice = str(error)
        data = central.snapshot(connection)
    health.problem = None
    return data, "http"


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
        return "http" if central_api.connection_of(connection, secrets) else None

    def off(connection) -> bool:
        return not modules.state(connection)["central"]

    @router.get("/central")
    async def get_central():
        found = await db(lambda c: None if off(c) else (central.snapshot(c), transport(c), central.legacy(c)))
        if found is None:
            return JSONResponse({"error": OFF}, status_code=404)
        data, way, legacy = found
        notice = central.MOVED if way is None and legacy else health.notice
        return {"configured": way is not None, "transport": way, "snapshot": public(data), "problem": health.problem, "notice": notice}

    @router.post("/central/refresh")
    async def refresh():
        def work(connection):
            if off(connection):
                return None
            data, way = read_now(connection, secrets, health)
            return (data, way) if way else NOT_CONFIGURED
        try:
            found = await db(work)
        except central.CentralError as error:
            health.problem = str(error)
            return JSONResponse({"error": str(error)}, status_code=502)
        if found is None:
            return JSONResponse({"error": OFF}, status_code=404)
        if found == NOT_CONFIGURED:  # a setting to make, not a failure: no warning is left behind
            return JSONResponse({"error": NOT_CONFIGURED}, status_code=502)
        health.problem = None
        return {"configured": True, "transport": found[1], "snapshot": public(found[0]), "problem": None, "notice": health.notice}

    return router
