"""Settings of Trabajos: which Hermes profile is the central bot, the default recipient of a new commission
(«encargo»). Stored by profile name, as Hermes assigns kanban cards; the root profile is «default»."""

import json
import re
from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from .db import DB_NAME, connect, transaction
from .settings import Settings

KEY = "jobs"
DEFAULTS = {"central": "default"}
# Hermes' own profile names: «default» or lowercase letters, digits, «-» and «_».
PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class JobsSettings(BaseModel):
    central: str = Field(min_length=1, max_length=64)

    @field_validator("central")
    @classmethod
    def profile_name(cls, value: str) -> str:
        if not PROFILE.fullmatch(value):
            raise ValueError("nombre de perfil de Hermes no válido")
        return value


def read(connection) -> dict:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (KEY,)).fetchone()
    saved = json.loads(row["value"]) if row else {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}


def jobs_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    @router.get("/jobs/settings")
    async def current():
        def work():
            with database() as connection:
                return read(connection)
        return await run_in_threadpool(work)

    @router.put("/jobs/settings")
    async def change(body: JobsSettings):
        def work():
            with database() as connection, transaction(connection):
                merged = {**read(connection), "central": body.central}
                connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                                   (KEY, json.dumps(merged)))
                return merged
        return await run_in_threadpool(work)

    return router
