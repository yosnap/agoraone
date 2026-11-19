"""HTTP routes of the user's clients: the directory (Central's, CRMDev's and the ones kept in AgoraOne, always
reachable, also with both CRMs off or not connected), the clients kept here (create, change, delete), the links between
sources («Enlazar», «Son distintos» and undoing it) and the vault's client cards without a client (read from the
brain's index, names only). The directory's list never carries an address, phone, tax id nor notes: only a client kept
here, asked by its id for its form, comes whole."""

from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import central, client_cards, clients, crmdev_api, crmdev_sync, modules
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


ID = r"^[A-Za-z0-9_-]{1,100}$"


class RemoteLinkIn(BaseModel):
    """A link of a client kept here with one of a connector's: `{centralId}` (Central, as always) or `{connector,
    remoteId, state}` (CRMDev)."""
    model_config = {"extra": "forbid"}
    centralId: str | None = Field(default=None, min_length=1, max_length=100)
    connector: str | None = Field(default=None, pattern=r"^[a-z]{1,40}$")
    remoteId: str | None = Field(default=None, pattern=ID)
    state: str = Field(default="linked", pattern=r"^(linked|distinct|undistinct)$")


class PairLinkIn(BaseModel):
    model_config = {"extra": "forbid"}
    centralId: str = Field(min_length=1, max_length=100)
    crmdevId: str = Field(pattern=ID)
    state: str = Field(pattern=r"^(linked|distinct|undistinct)$")


def clients_router(settings: Settings, secrets=None, crmdev_health: crmdev_sync.CrmdevHealth | None = None) -> APIRouter:
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
    async def get_clients(discreet: bool = False):
        """The directory, its suggestions, how many are «sin ubicar», the state of each source and the vault's cards
        without a client (in discreet mode only normal ones are named)."""
        def work(connection):
            entries, suggestions = clients.build(connection)
            on = modules.state(connection)
            crmdev_read = crmdev_sync.stored(connection)
            # «Crear en CRMDev» needs the key too; the clients already read are used with the URL saved, as Central's.
            connected = secrets is not None and on["crmdev"] and crmdev_api.connection_of(connection, secrets) is not None
            return {"clients": [clients.public(e) for e in entries], "suggestions": suggestions, "distinctPairs": clients.remote_pairs(connection),
                    "unplacedCount": sum(1 for e in entries if e["unplaced"]),
                    "central": {"on": on["central"], "read": central.stored(connection) is not None},
                    "crmdev": {"on": on["crmdev"], "connected": connected, "read": crmdev_read is not None,
                               "fetchedAt": (crmdev_read or {}).get("fetchedAt"), "truncated": bool((crmdev_read or {}).get("truncated")),
                               "problem": crmdev_health.problem if crmdev_health and on["crmdev"] else None},
                    "vaultCards": client_cards.vault_cards(connection, entries, discreet)}
        return await db(work)

    @router.get("/clients/{client_id}")
    async def get_client(client_id: int):
        """A client kept here, whole, for its form (the screen hides its contact in discreet mode)."""
        found = await db(lambda c: clients.get(c, client_id))
        return found if found else not_found()

    def failed(error: clients.ClientError) -> JSONResponse:
        return refuse(str(error), 409 if isinstance(error, clients.ClientConflict) else 422)

    @router.post("/clients", status_code=201)
    async def create_client(body: ClientIn):
        try:
            return await db(lambda c: clients.create(c, body.model_dump()))
        except clients.ClientError as error:
            return failed(error)

    @router.patch("/clients/{client_id}")
    async def change_client(client_id: int, body: ClientIn):
        try:
            found = await db(lambda c: clients.update(c, client_id, body.model_dump(exclude_unset=True)))
        except clients.ClientError as error:
            return failed(error)
        return found if found else not_found()

    @router.delete("/clients/{client_id}")
    async def delete_client(client_id: int):
        """Only a client kept here (the screen asks first, saying how many meetings name it); a copy of it is kept
        first. Central's are never touched from AgoraOne."""
        found = await db(lambda c: clients.delete(c, client_id))
        return {"deleted": True, "references": found["references"]} if found else not_found()

    async def link(client_id: int, body: LinkIn, state: str):
        try:
            found = await db(lambda c: clients.set_link(c, client_id, body.centralId, state))
        except clients.ClientError as error:
            return refuse(str(error))
        return found if found else not_found()

    @router.post("/clients/{client_id}/link")
    async def link_client(client_id: int, body: RemoteLinkIn):
        """«Enlazar»: the user confirmed this client and that one of Central's are the same (`{centralId}`). With
        `{connector: "crmdev", remoteId, state}`: «Enlazar», «Son distintos» or undoing it with one of CRMDev's."""
        if body.connector is None:
            if body.centralId is None or body.remoteId is not None or body.state != "linked":
                return refuse("Indica el cliente de Central.")
            return await link(client_id, LinkIn(centralId=body.centralId), "linked")
        if body.centralId is not None or body.remoteId is None:
            return refuse("Indica el cliente del conector.")
        try:
            found = await db(lambda c: clients.set_remote_link(c, client_id, body.connector, body.remoteId, body.state))
        except clients.ClientError as error:
            return refuse(str(error))
        return found if found else not_found()

    @router.post("/clients/pairs")
    async def link_pair(body: PairLinkIn):
        """«Enlazar», «Son distintos» or undoing it between one of Central's clients and one of CRMDev's."""
        try:
            await db(lambda c: clients.set_pair_link(c, body.centralId, body.crmdevId, body.state))
        except clients.ClientError as error:
            return refuse(str(error))
        return {"done": True}

    @router.post("/clients/{client_id}/distinct")
    async def distinct_client(client_id: int, body: LinkIn):
        """«Son distintos»: never linked nor suggested with that one of Central's again (also undoes a link)."""
        return await link(client_id, body, "distinct")

    @router.post("/clients/{client_id}/undistinct")
    async def undistinct_client(client_id: int, body: LinkIn):
        """Undoes a «Son distintos» from the client's form: that pair may be linked or suggested again."""
        return await link(client_id, body, "undistinct")

    return router
