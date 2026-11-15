"""HTTP routes for opening applications: the installed ones, the list Watson may open, and opening one."""

from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import apps
from .db import DB_NAME, connect
from .settings import Settings


class Allowed(BaseModel):
    allowed: list[str]


class Open(BaseModel):
    id: str
    confirmed: bool = False


def apps_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    async def run(work):
        def job():
            with database() as connection:
                return work(connection)
        try:
            return await run_in_threadpool(job)
        except apps.AppsError as error:
            return JSONResponse({"error": str(error)}, status_code=error.status)

    @router.get("/apps")
    async def listing():
        return await run(lambda c: {"apps": apps.installed(), "allowed": apps.allowed(c)})

    @router.put("/apps/allowed")
    async def change(body: Allowed):
        return await run(lambda c: {"allowed": apps.save_allowed(c, body.allowed)})

    @router.post("/apps/open")
    async def open_one(body: Open):
        return await run(lambda c: {"done": apps.open_app(c, body.id, body.confirmed)})

    return router
