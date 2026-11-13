"""HTTP route of the summary page: the core's own numbers, for the owner's screen."""

import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool

from . import __version__, addons
from .db import DB_NAME, connect
from .index import status
from .settings import Settings
from .summary import NoteWords, watson

WINDOWS = {"24h": 24, "7d": 168, "30d": 720}


def summary_router(settings: Settings, started: float) -> APIRouter:
    router = APIRouter()
    note_words = NoteWords()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def costguard(connection) -> dict:
        data = Path(addons.config(connection, "costguard").get("dataPath") or "")
        if not addons.is_costguard_data(data):
            return {"available": False}
        try:
            return {"available": True, **{
                name: {"projects": addons.costguard_projects(data, hours), "agents": addons.costguard_usage(data, hours)["agents"]}
                for name, hours in WINDOWS.items()
            }}
        except addons.AddonError:
            return {"available": False}

    @router.get("/summary")
    async def summary(discreet: bool = Query(False)):
        def read():
            with database() as connection:
                return {
                    "core": {"version": __version__, "startedAt": datetime.fromtimestamp(started, UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "uptimeSeconds": int(time.time() - started)},
                    "brain": status(connection),
                    "watson": watson(connection),
                    "noteWords": note_words.get(connection, discreet),
                    "costguard": costguard(connection),
                }
        return await run_in_threadpool(read)

    return router
