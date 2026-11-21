"""HTTP routes of Orca's bots (`orca_bots`): `GET /orca/bots` lists the user's bots and says whether AgoraOne's mailbox
in Orca is ready; `POST /orca/mailbox` creates the mailbox, only when the user presses «Crear el buzón de AgoraOne».
An errand goes in two steps, like every action of AgoraOne: `POST /orca/bots/preview` returns its exact text with a
single-use id (15 minutes, this screen only) and `POST /orca/bots/send` sends exactly that once, after checking again
what may have changed. Watson has no tool that reaches these routes. With the «Orca» module off they say so and ask
Orca nothing."""

import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import modules, orca_bots
from .db import DB_NAME, connect
from .orca_launch import OrcaError
from .settings import Settings

from .routes_orca import LaunchSource

OFF = "El módulo Orca está apagado en Ajustes."
OWNER = re.compile(r"[a-f0-9]{64}")
KEEP = 15 * 60
MAX_PLANS = 50


class ErrandRequest(BaseModel):
    client: str = Field(max_length=200)
    project: str = Field(max_length=200)
    task: str = Field(max_length=8000)
    bot: str = Field(min_length=1, max_length=64)
    kind: Literal["handoff", "question"]
    source: LaunchSource | None = None


class ErrandConfirm(BaseModel):
    id: str = Field(min_length=16, max_length=64)


def orca_bots_router(settings: Settings, secrets_store=None) -> APIRouter:
    router = APIRouter()
    plans: dict[str, dict] = {}

    def owner_of(request: Request) -> str | None:
        owner = request.headers.get("x-agora-owner", "")
        return owner if OWNER.fullmatch(owner) else None

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

    @router.post("/orca/bots/preview")
    async def preview(body: ErrandRequest, request: Request):
        owner = owner_of(request)
        if not owner:
            return JSONResponse({"error": "Sin acceso."}, status_code=403)

        def work():
            with database() as connection:
                if not on(connection):
                    raise OrcaError(OFF)
                return orca_bots.preview(connection, body.model_dump(), secrets_store=secrets_store)
        try:
            plan = await run_in_threadpool(work)
        except OrcaError as error:
            return JSONResponse({"error": str(error)}, status_code=422)
        now = time.time()
        for key in [k for k, v in plans.items() if v["expires"] < now]:
            plans.pop(key, None)
        while len(plans) >= MAX_PLANS:
            plans.pop(next(iter(plans)))
        ident = secrets.token_urlsafe(16)
        plans[ident] = {"plan": plan, "owner": owner, "expires": now + KEEP}
        return {"id": ident, **plan}

    @router.post("/orca/bots/send", status_code=201)
    async def send(body: ErrandConfirm, request: Request):
        owner = owner_of(request)
        found = plans.get(body.id)
        if not owner or found is None or found["owner"] != owner or found["expires"] < time.time():
            return JSONResponse({"error": "Esa vista previa ya no vale: vuelve a prepararla."}, status_code=409)
        plans.pop(body.id, None)  # taken before any wait: a double click sends once

        def work():
            with database() as connection:
                if not on(connection):
                    raise OrcaError(OFF)
                return orca_bots.send(connection, found["plan"], secrets_store=secrets_store)
        try:
            return await run_in_threadpool(work)
        except orca_bots.UnsureSend as error:
            return JSONResponse({"error": str(error), "status": "unsure"}, status_code=502)
        except OrcaError as error:
            return JSONResponse({"error": f"{error} No se ha enviado nada."}, status_code=422)

    return router
