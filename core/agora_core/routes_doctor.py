"""«Qué tengo instalado» (1.6): the diagnosis, read-only."""

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import doctor, installer, jev, modules, zernio
from .db import DB_NAME, connect, transaction
from .engines import SECRET_ACCOUNTS
from .settings import Settings


class Install(BaseModel):
    id: str


class FirstRun(BaseModel):
    done: bool


class Modules(BaseModel):
    modules: dict[str, bool]


def doctor_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()
    jobs = installer.Installer()

    def diagnose():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            return doctor.check(connection, bool(secrets.get(SECRET_ACCOUNTS["anthropic"])), bool(secrets.get(zernio.SECRET)), bool(secrets.get(jev.SECRET)))
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

    # The first start's guide is shown until finished or skipped once, in any browser (1.6).
    @router.get("/setup/first-run")
    async def first_run():
        return await run_in_threadpool(lambda: {"done": with_db(lambda c: bool(c.execute("SELECT 1 FROM setting WHERE key = 'setup.firstRun'").fetchone()))})

    @router.put("/setup/first-run")
    async def first_run_done(body: FirstRun):
        def work(connection):
            with transaction(connection):
                if body.done:
                    connection.execute("INSERT INTO setting (key, value) VALUES ('setup.firstRun', 'true') ON CONFLICT (key) DO NOTHING")
                else:
                    connection.execute("DELETE FROM setting WHERE key = 'setup.firstRun'")
            return {"done": body.done}
        return await run_in_threadpool(lambda: with_db(work))

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
