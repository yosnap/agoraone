"""«Qué tengo instalado» (1.6): the diagnosis, read-only."""

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import doctor, installer, modules
from .db import DB_NAME, connect
from .engines import SECRET_ACCOUNTS
from .settings import Settings


class Install(BaseModel):
    id: str


class Modules(BaseModel):
    modules: dict[str, bool]


def doctor_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()
    jobs = installer.Installer()

    def diagnose():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            return doctor.check(connection, bool(secrets.get(SECRET_ACCOUNTS["anthropic"])))
        finally:
            connection.close()

    @router.get("/doctor")
    async def diagnosis():
        return await run_in_threadpool(diagnose)

    def with_db(work):
        connection = connect(settings.data_dir / DB_NAME)
        try:
            return work(connection)
        finally:
            connection.close()

    @router.get("/modules")
    async def list_modules():
        return await run_in_threadpool(lambda: {"modules": with_db(modules.state), "labels": modules.MODULES})

    @router.put("/modules")
    async def change_modules(body: Modules):
        return await run_in_threadpool(lambda: {"modules": with_db(lambda c: modules.save(c, body.modules)), "labels": modules.MODULES})

    @router.get("/doctor/install")
    async def install_state():
        return {"job": jobs.state()}

    @router.post("/doctor/install")
    async def install(body: Install):
        """Installs one piece of the diagnosis, by its id: what runs comes from the diagnosis, never from here."""
        def work():
            piece = next((p for p in diagnose()["pieces"] if p["id"] == body.id), None)
            if piece is None or piece["state"] == "ok":
                raise installer.InstallError("Esa pieza no existe o ya está instalada.", 404)
            return {"job": jobs.start(piece)}
        try:
            return await run_in_threadpool(work)
        except installer.InstallError as error:
            return JSONResponse({"error": str(error)}, status_code=error.status)

    return router
