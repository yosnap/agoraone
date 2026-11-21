"""Routes for AgoraOne's own log (Ajustes › Registro): read it, and let the interface add its errors."""

from typing import Literal

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import app_log
from .settings import Settings


class ClientEntry(BaseModel):
    level: Literal["info", "warning", "error"]
    area: str = Field(default="interfaz", max_length=60)
    message: str = Field(min_length=1, max_length=2000)


def logs_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.get("/logs")
    async def logs(
        level: Literal["debug", "info", "warning", "error"] | None = None,
        q: str | None = Query(default=None, max_length=200),
        source: Literal["núcleo", "interfaz"] | None = None,
        limit: int = Query(default=300, ge=1, le=2000),
    ):
        entries = await run_in_threadpool(app_log.read, settings.data_dir, level, q, source, limit)
        return {"entries": entries, "bytes": app_log.size(settings.data_dir), "maxBytes": app_log.MAX_BYTES * (app_log.BACKUPS + 1)}

    @router.post("/logs/client", status_code=204)
    async def client(entry: ClientEntry):
        app_log.record(entry.level, "interfaz", entry.area, entry.message)

    return router
