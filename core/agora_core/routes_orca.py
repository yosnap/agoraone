"""HTTP routes of the Orca module: whether it can be used, the exact preview of a launch and the launch itself,
which only runs a preview the same owner saw, once, within 15 minutes."""

import re
import secrets
import time

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import modules, orca_launch
from .db import DB_NAME, connect
from .settings import Settings

_OWNER = re.compile(r"[a-f0-9]{64}")
KEEP = 15 * 60
MAX_PLANS = 50


class LaunchSource(BaseModel):
    kind: str | None = None
    id: int | None = None
    url: str | None = None
    source: str | None = None
    ref: str | None = None
    revision: str | None = None


class LaunchRequest(BaseModel):
    client: str
    project: str
    task: str
    agent: str = "claude"
    source: LaunchSource | None = None


class LaunchConfirm(BaseModel):
    id: str


def orca_router(settings: Settings) -> APIRouter:
    router = APIRouter()
    plans: dict[str, dict] = {}

    def owner_of(request: Request) -> str | None:
        owner = request.headers.get("x-agora-owner", "")
        return owner if _OWNER.fullmatch(owner) else None

    def module_on() -> bool:
        connection = connect(settings.data_dir / DB_NAME)
        try:
            return modules.state(connection)["orca"]
        finally:
            connection.close()

    def refuse(message: str, status: int = 422):
        return JSONResponse({"error": message}, status_code=status)

    @router.get("/orca")
    async def status():
        return {"installed": orca_launch.binary() is not None, "on": await run_in_threadpool(module_on), "agents": orca_launch.AGENTS}

    @router.get("/orca/projects")
    async def ready():
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                if orca_launch.binary() is None or not modules.state(connection)["orca"]:
                    return {"projects": [], "problem": None}
                return orca_launch.ready_projects(connection)
            finally:
                connection.close()
        return await run_in_threadpool(run)

    @router.post("/orca/preview")
    async def preview(body: LaunchRequest, request: Request):
        owner = owner_of(request)
        if not owner:
            return refuse("Sin acceso.", 403)

        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                if not modules.state(connection)["orca"]:
                    raise orca_launch.OrcaError("El módulo Orca está apagado en Ajustes.")
                return orca_launch.preview(connection, body.model_dump())
            finally:
                connection.close()

        try:
            plan = await run_in_threadpool(run)
        except orca_launch.OrcaError as error:
            return refuse(str(error))
        now = time.time()
        for key in [k for k, v in plans.items() if v["expires"] < now]:
            plans.pop(key, None)
        while len(plans) >= MAX_PLANS:
            plans.pop(next(iter(plans)))
        ident = secrets.token_urlsafe(16)
        plans[ident] = {"plan": plan, "owner": owner, "expires": now + KEEP}
        return {"id": ident, **{k: v for k, v in plan.items() if k != "orcaProject"}}

    @router.post("/orca/launch", status_code=201)
    async def launch(body: LaunchConfirm, request: Request):
        owner = owner_of(request)
        found = plans.get(body.id)
        if not owner or found is None or found["owner"] != owner or found["expires"] < time.time():
            return refuse("Esa vista previa ya no vale: vuelve a prepararla.", 409)
        plans.pop(body.id, None)  # taken before any wait: a double click launches once
        if not await run_in_threadpool(module_on):
            return refuse("El módulo Orca está apagado en Ajustes.")
        plan = found["plan"]

        def still_allowed():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                orca_launch.recheck(connection, plan)
            finally:
                connection.close()

        try:
            await run_in_threadpool(still_allowed)
        except orca_launch.OrcaError as error:
            return refuse(f"{error} No se ha lanzado nada.")

        def record(outcome: str):
            connection = connect(settings.data_dir / DB_NAME)
            try:
                orca_launch.log(connection, plan, outcome)
            finally:
                connection.close()

        try:
            started = await run_in_threadpool(orca_launch.launch, plan)
        except orca_launch.OrcaError as error:
            await run_in_threadpool(record, "failed")
            return refuse(str(error), 502)
        await run_in_threadpool(record, "done")
        return {**started, "repo": plan["repo"], "agentName": plan["agentName"]}

    return router
