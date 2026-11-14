"""HTTP routes of the add-ons registry."""

from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictInt

from . import addons
from .db import DB_NAME, connect
from .settings import Settings


class AddonIn(BaseModel):
    path: str | None = Field(default=None, max_length=500)
    dataPath: str | None = Field(default=None, max_length=500)
    port: StrictInt | None = None


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

    @router.get("")
    async def list_addons():
        return {"addons": await db(addons.describe)}

    @router.put("/{addon}")
    async def configure(addon: Literal["central", "costguard", "fabrica"], body: AddonIn):
        changes = body.model_dump(exclude_unset=True)  # an explicit null forgets that setting
        try:
            await db(lambda c: addons.save_config(c, addon, changes))
        except addons.AddonError as error:
            return JSONResponse({"error": str(error)}, status_code=422)
        return {"addons": await db(addons.describe)}

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
