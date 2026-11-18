"""HTTP routes of the user's clients: the directory (Central's and the ones kept in AgoraOne, always reachable, also
with Central off or not connected), the clients kept here (create, change, delete) and the links with Central's
(«Enlazar», «Son distintos»). The directory's list never carries an address, phone, tax id nor notes: only a
client kept here, asked by its id for its form, comes whole."""

from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import central, clients, modules
from .db import DB_NAME, connect
from .settings import Settings


class ClientIn(BaseModel):
    name: str | None = Field(default=None, max_length=400)
    company: str | None = Field(default=None, max_length=400)
    email: str | None = Field(default=None, max_length=400)
    phone: str | None = Field(default=None, max_length=80)
    taxId: str | None = Field(default=None, max_length=60)
    domains: list[str] | None = Field(default=None, max_length=clients.MAX_DOMAINS)
    notes: str | None = Field(default=None, max_length=8000)


class LinkIn(BaseModel):
    centralId: str = Field(min_length=1, max_length=100)


def clients_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    async def db(work):
        def task():
            with database() as connection:
                return work(connection)
        return await run_in_threadpool(task)

    def refuse(message: str, status: int = 422) -> JSONResponse:
        return JSONResponse({"error": message}, status_code=status)

    def not_found() -> JSONResponse:
        return refuse("Ese cliente no existe.", 404)

    @router.get("/clients")
    async def get_clients():
        def work(connection):
            entries, suggestions = clients.build(connection)
            return {"clients": [clients.public(e) for e in entries], "suggestions": suggestions,
                    "central": {"on": modules.state(connection)["central"], "read": central.stored(connection) is not None}}
        return await db(work)

    @router.get("/clients/{client_id}")
    async def get_client(client_id: int):
        """A client kept here, whole, for its form (the screen hides its contact in discreet mode)."""
        found = await db(lambda c: clients.get(c, client_id))
        return found if found else not_found()

    @router.post("/clients", status_code=201)
    async def create_client(body: ClientIn):
        try:
            return await db(lambda c: clients.create(c, body.model_dump()))
        except clients.ClientError as error:
            return refuse(str(error))

    @router.patch("/clients/{client_id}")
    async def change_client(client_id: int, body: ClientIn):
        try:
            found = await db(lambda c: clients.update(c, client_id, body.model_dump(exclude_unset=True)))
        except clients.ClientError as error:
            return refuse(str(error))
        return found if found else not_found()

    @router.delete("/clients/{client_id}")
    async def delete_client(client_id: int):
        """Only a client kept here (the screen asks first); Central's are never touched from AgoraOne."""
        return {"deleted": True} if await db(lambda c: clients.delete(c, client_id)) else not_found()

    async def link(client_id: int, body: LinkIn, state: str):
        try:
            found = await db(lambda c: clients.set_link(c, client_id, body.centralId, state))
        except clients.ClientError as error:
            return refuse(str(error))
        return found if found else not_found()

    @router.post("/clients/{client_id}/link")
    async def link_client(client_id: int, body: LinkIn):
        """«Enlazar»: the user confirmed this client and that one of Central's are the same."""
        return await link(client_id, body, "linked")

    @router.post("/clients/{client_id}/distinct")
    async def distinct_client(client_id: int, body: LinkIn):
        """«Son distintos»: never linked nor suggested with that one of Central's again (also undoes a link)."""
        return await link(client_id, body, "distinct")

    return router
