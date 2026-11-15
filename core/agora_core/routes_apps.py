"""HTTP routes for opening applications: the installed ones, the list Watson may open, and opening one."""

import json
from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import apps
from .db import DB_NAME, connect, transaction
from .settings import Settings


class Allowed(BaseModel):
    allowed: list[str]


class Wake(BaseModel):
    enabled: bool


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

    # «Oye Watson» (1.5): off unless the user turns it on, since it keeps the microphone open. The desktop app
    # reads this to start or stop its on-device listener.
    def wake(connection) -> dict:
        row = connection.execute("SELECT value FROM setting WHERE key = 'wake'").fetchone()
        return {"enabled": bool(row and json.loads(row["value"]).get("enabled"))}

    @router.get("/wake/settings")
    async def wake_settings():
        return await run(wake)

    @router.put("/wake/settings")
    async def change_wake(body: Wake):
        def work(connection):
            with transaction(connection):
                connection.execute("INSERT INTO setting (key, value) VALUES ('wake', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                                   (json.dumps({"enabled": body.enabled}),))
            return wake(connection)
        return await run(work)

    return router
