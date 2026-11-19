"""HTTP route of CostGuard's usage (what it read, not its connection, which is made through the connectors)."""

from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import addons
from .db import DB_NAME, connect
from .settings import Settings


def addons_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/addons")

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def db(work):
        def task():
            with database() as connection:
                return work(connection)
        return run_in_threadpool(task)

    @router.get("/costguard/usage")
    async def costguard_usage(hours: int = 5):
        hours = max(1, min(hours, 168))
        current = await db(lambda c: addons.config(c, "costguard"))
        data = Path(current.get("dataPath") or "")
        if not addons.is_costguard_data(data):
            return JSONResponse({"error": "CostGuard no está instalado o no se encuentra su archivo de datos."}, status_code=404)
        try:
            return await run_in_threadpool(addons.costguard_usage, data, hours)
        except addons.AddonError as error:
            return JSONResponse({"error": str(error)}, status_code=503)

    return router
