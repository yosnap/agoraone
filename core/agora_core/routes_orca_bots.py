"""HTTP routes of Orca's bots (`orca_bots`): `GET /orca/bots` lists the user's bots and says whether AgoraOne's mailbox
in Orca is ready; `POST /orca/mailbox` creates the mailbox, only when the user presses «Crear el buzón de AgoraOne».
With the «Orca» module off they say so and ask Orca nothing. Nothing here sends anything to a bot."""

import sqlite3
from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import modules, orca_bots
from .db import DB_NAME, connect
from .orca_launch import OrcaError
from .settings import Settings

OFF = "El módulo Orca está apagado en Ajustes."


def orca_bots_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def on(connection: sqlite3.Connection) -> bool:
        return modules.state(connection)["orca"]

    @router.get("/orca/bots")
    async def listed():
        def work():
            with database() as connection:
                if not on(connection):
                    return {"on": False, "bots": [], "mailbox": None, "problem": OFF}
                try:
                    return {"on": True, "bots": orca_bots.bots(), "mailbox": orca_bots.status(connection), "problem": None}
                except OrcaError as error:
                    return {"on": True, "bots": [], "mailbox": None, "problem": str(error)}
        return await run_in_threadpool(work)

    @router.post("/orca/mailbox")
    async def create_mailbox():
        def work():
            with database() as connection:
                if not on(connection):
                    return JSONResponse({"error": OFF}, status_code=404)
                try:
                    return orca_bots.create(connection)
                except OrcaError as error:
                    return JSONResponse({"error": str(error)}, status_code=409)
        return await run_in_threadpool(work)

    return router
