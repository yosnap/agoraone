"""HTTP routes of Central's snapshot (clients and servers, read-only) and its refresh every half hour."""

import sqlite3
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import addons, central
from .db import DB_NAME, connect
from .settings import Settings

REFRESH_SECONDS = 1800


class CentralHealth:
    def __init__(self):
        self.problem: str | None = None


def _folder(connection: sqlite3.Connection) -> Path | None:
    path = addons.config(connection, "central").get("path")
    return Path(path) if path and addons.recognised("central", Path(path)) else None


def central_worker(settings: Settings, stop: threading.Event, health: CentralHealth) -> None:
    stop.wait(30)
    while not stop.is_set():
        try:
            connection = connect(settings.data_dir / DB_NAME)
            try:
                folder = _folder(connection)
                if folder:
                    central.refresh(connection, folder)
                    health.problem = None
            finally:
                connection.close()
        except Exception as error:  # noqa: BLE001 - the worker survives anything and says so
            if health.problem is None:
                print(f"AgoraOne núcleo: lectura de Central en pausa ({type(error).__name__})", file=sys.stderr)
            health.problem = str(error)[:200] if isinstance(error, central.CentralError) else "No se pudo leer Central."
        stop.wait(REFRESH_SECONDS)


def central_router(settings: Settings, health: CentralHealth) -> APIRouter:
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

    @router.get("/central")
    async def get_central():
        data, configured = await db(lambda c: (central.snapshot(c), _folder(c) is not None))
        return {"configured": configured, "snapshot": data, "problem": health.problem}

    @router.post("/central/refresh")
    async def refresh():
        def work(connection):
            folder = _folder(connection)
            if folder is None:
                raise central.CentralError("Central no está configurado: indica su carpeta en Conectores.")
            return central.refresh(connection, folder)
        try:
            data = await db(work)
        except central.CentralError as error:
            health.problem = str(error)
            return JSONResponse({"error": str(error)}, status_code=502)
        health.problem = None
        return {"configured": True, "snapshot": data, "problem": None}

    return router
