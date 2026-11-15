"""«Qué tengo instalado» (1.6): the diagnosis, read-only."""

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

from . import doctor
from .db import DB_NAME, connect
from .engines import SECRET_ACCOUNTS
from .settings import Settings


def doctor_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()

    @router.get("/doctor")
    async def diagnosis():
        def work():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                return doctor.check(connection, bool(secrets.get(SECRET_ACCOUNTS["anthropic"])))
            finally:
                connection.close()
        return await run_in_threadpool(work)

    return router
