"""HTTP routes of CRMDev's organizations (Conectores › CRMDev), each with the name the user gives it and its own key:

- `GET /crmdev/orgs`: the organizations, whether each key is saved and what was last read of each (counts and when).
- `POST /crmdev/orgs` `{name, key}`: a new one; its clients and projects are read right after (a failure is said).
- `PATCH /crmdev/orgs/{id}` `{name?, key?}`: rename it or change its key.
- `POST /crmdev/orgs/{id}/test`: «Probar» with that organization's key (asks the tool list: no tool runs).
- `DELETE /crmdev/orgs/{id}`: forgets one (its key leaves the store; nothing is deleted in CRMDev).

Never a key in an answer, an error or the log. The «CRMDev» module off → 404."""

from contextlib import contextmanager

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import crmdev_api, crmdev_orgs, crmdev_sync, modules, web_api
from .db import DB_NAME, connect
from .settings import Settings

OFF = "El módulo CRMDev está apagado."
GONE = "Esa organización ya no está."


def crmdev_orgs_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def problem(status: int, message: str) -> JSONResponse:
        return JSONResponse({"error": message}, status_code=status)

    async def run(work):
        def task():
            with database() as connection:
                if not modules.state(connection)["crmdev"]:
                    return problem(404, OFF)
                return work(connection)
        try:
            return await run_in_threadpool(task)
        except crmdev_orgs.OrgError as error:
            return problem(422, str(error))
        except web_api.WebApiError as error:  # fixed sentences: never the key nor the address
            return problem(503 if error.status == "config" else 502, str(error))

    def listed(connection) -> dict:
        found = []
        for org in crmdev_orgs.orgs(connection):
            try:
                has_key = web_api.read_key(crmdev_orgs.spec_of(org["id"]), secrets) is not None
            except web_api.WebApiError:
                has_key = False
            snap = crmdev_sync.stored(connection, org["id"]) or {}
            found.append({**org, "hasKey": has_key, "clients": len(snap.get("clients") or []) if snap else None,
                          "projects": len(snap.get("projects") or []) if snap else None, "fetchedAt": snap.get("fetchedAt")})
        return {"orgs": found}

    async def body_of(request: Request) -> dict | None:
        try:
            found = await request.json()
        except ValueError:
            return None
        return found if isinstance(found, dict) else None

    @router.get("/crmdev/orgs")
    async def all_orgs():
        return await run(listed)

    @router.post("/crmdev/orgs")
    async def add(request: Request):
        body = await body_of(request)
        if body is None or set(body) - {"name", "key"}:
            return problem(422, "Escribe el nombre de la organización y su clave.")

        def work(connection):
            org = crmdev_orgs.add(connection, secrets, body.get("name"), body.get("key"))
            warning = None
            try:
                target = crmdev_api.connection_of(connection, secrets, org["id"])
                if target is not None:
                    crmdev_sync.refresh(connection, target, org["id"])
            except web_api.WebApiError as error:
                warning = f"Guardada, pero no se pudo leer todavía: {error}"
            return {**listed(connection), "added": org["id"], **({"warning": warning} if warning else {})}
        return await run(work)

    @router.patch("/crmdev/orgs/{org}")
    async def change(org: str, request: Request):
        body = await body_of(request)
        if body is None or not body or set(body) - {"name", "key"}:
            return problem(422, "Indica el nombre nuevo o la clave nueva.")

        def work(connection):
            if not crmdev_orgs.known(connection, org):
                return problem(404, GONE)
            if "name" in body:
                crmdev_orgs.rename(connection, org, body["name"])
            if "key" in body:
                crmdev_orgs.set_key(connection, secrets, org, body["key"])
            return listed(connection)
        return await run(work)

    @router.post("/crmdev/orgs/{org}/test")
    async def test(org: str):
        def work(connection):
            if not crmdev_orgs.known(connection, org):
                return problem(404, GONE)
            target = crmdev_api.connection_of(connection, secrets, org)
            if target is None:
                return problem(409, "Esa organización no tiene clave guardada.")
            return {"org": org, **crmdev_api.probe(target)}
        return await run(work)

    @router.delete("/crmdev/orgs/{org}")
    async def forget(org: str):
        def work(connection):
            crmdev_orgs.forget(connection, secrets, org)
            return listed(connection)
        return await run(work)

    return router
