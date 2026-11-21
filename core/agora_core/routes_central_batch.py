"""HTTP routes of the clients born in Central:

- `GET /client-births` and `POST /client-births/dismiss`: the proposals «Crear cliente en Central» (`client_births`),
  without addresses nor numbers, and «Descartar» / «Volver a mostrar».
- `POST /central/batch/preview` `{items: [{key, name?}], anyway?}`: each ticked client (kept here, of CRMDev or a
  proposal) exactly as it will be created, checked against Central read now, and what cannot go; a single-use token
  valid 15 minutes. Needs a key of Central with «escritura».
- `POST /central/batch/confirm` `{token}`: creates them one after another, once; then links each with its source and
  reads Central again. The action log keeps only the origin and the field names.

The «Central» module off → 404, without a connection → 409, without «escritura» → 403. Watson has no tool that reaches
these routes and no mail, message or meeting triggers them. Never the key nor a value in an error or in the log."""

import json
import logging
import sqlite3
import time
from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import central, central_api, central_batch, client_births, clients, modules
from .confirmed_change import Pending, PendingChanges, Refused, Sentences
from .db import DB_NAME, connect, now, transaction
from .routes_central_write import NO_WRITE, NOT_CONNECTED, OFF, STATUS_CODES, central_of
from .routes_crmdev_write import DOUBT_SECONDS
from .settings import Settings

EXPIRED = "Esa revisión ya no vale (caduca a los 15 minutos): vuelve a revisar."
SENDING = "Ese envío ya está en marcha."
DONE = "Ese envío ya se hizo: revisa otra vez."
BUSY = "Hay otro envío a Central en marcha: espera a que termine."
MOVED = "La conexión con Central ha cambiado desde la revisión: vuelve a revisar."
NOTHING = "Nada de lo marcado puede crearse ahora en Central."
LOG = logging.getLogger(__name__)


class ItemIn(BaseModel):
    model_config = {"extra": "forbid"}
    key: str = Field(min_length=1, max_length=120)
    name: str | None = Field(default=None, max_length=200)


class BatchIn(BaseModel):
    model_config = {"extra": "forbid"}
    items: list[ItemIn] = Field(min_length=1, max_length=300)
    anyway: list[str] = Field(default_factory=list, max_length=300)


class ConfirmIn(BaseModel):
    model_config = {"extra": "forbid"}
    token: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class DismissIn(BaseModel):
    model_config = {"extra": "forbid"}
    key: str = Field(min_length=1, max_length=80)
    dismissed: bool = True


def central_batch_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()
    pending: PendingChanges[central_batch.Batch] = PendingChanges(Sentences(EXPIRED, SENDING, DONE, BUSY), 900, 20)
    doubtful: dict[str, float] = {}

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

    def problem(status: int, message: str, kind: str, **extra) -> JSONResponse:
        return JSONResponse({"error": message, "status": kind, **extra}, status_code=status)

    def failed(error: central_api.CentralApiError) -> JSONResponse:
        return problem(STATUS_CODES.get(error.status, 502), str(error) or NO_WRITE, error.status)

    def prepare() -> tuple[bool, central_api.Connection | None]:
        with database() as connection:
            if not modules.state(connection)["central"]:
                return False, None
            return True, central_api.connection_of(connection, secrets)

    def is_doubtful(key: str) -> bool:
        cutoff = time.time() - DOUBT_SECONDS
        for old in [k for k, at in doubtful.items() if at < cutoff]:
            doubtful.pop(old, None)
        return key in doubtful

    def doubt(key: str) -> None:
        doubtful[key] = time.time()
        while len(doubtful) > 500:
            doubtful.pop(next(iter(doubtful)))

    @router.get("/client-births")
    async def births(all: bool = False):
        """Who writes or meets the user and is no client yet (only what is «normal»): never an address nor a number."""
        return await db(lambda c: client_births.build(c, include_dismissed=all))

    @router.post("/client-births/dismiss")
    async def dismiss_birth(body: DismissIn):
        try:
            await db(lambda c: client_births.dismiss(c, body.key, body.dismissed))
        except client_births.BirthError as error:
            return problem(422, str(error), "invalid")
        return {"done": True}

    @router.post("/central/batch/preview")
    async def preview(body: BatchIn):
        if any(not central_batch.valid_key(i.key) for i in body.items) or any(not central_batch.valid_key(k) for k in body.anyway):
            return problem(422, "Un cliente marcado no es válido.", "invalid")
        on, target = await run_in_threadpool(prepare)
        if not on:
            return problem(404, OFF["central"], "off")
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")

        def plan():
            if not {"escritura", "lectura"} <= set(central_api.status(target)["scopes"]):
                raise central_api.CentralApiError("forbidden", NO_WRITE)
            with database() as connection:
                items = [{"key": i.key, "name": " ".join(i.name.split()) if i.name else None} for i in body.items]
                return central_batch.plan(connection, target, items, is_doubtful, set(body.anyway))
        try:
            batch = await run_in_threadpool(plan)
        except central_api.CentralApiError as error:
            return failed(error)
        if not batch.operations:
            return problem(422, NOTHING, "nothing", skipped=batch.skipped)
        return {"token": pending.preview(batch, central_of(target)), **batch.public()}

    @router.post("/central/batch/confirm")
    async def confirm(body: ConfirmIn):
        try:
            return await pending.confirm(body.token, send)
        except Refused as refused:
            return problem(refused.status, str(refused), refused.kind)

    async def send(token: str, entry: Pending[central_batch.Batch]):
        on, target = await run_in_threadpool(prepare)
        if not on or target is None:
            pending.drop(token)
            return problem(404, OFF["central"], "off") if not on else problem(409, NOT_CONNECTED, "not_connected")
        if central_of(target) != entry.owner:
            pending.drop(token)
            return problem(409, MOVED, "expired")
        try:
            results = await run_in_threadpool(central_batch.send, target, entry.change, doubt)
        except central_api.CentralApiError as error:  # the first reading failed: nothing was sent
            entry.state = "ready"
            return failed(error)
        except Exception:
            entry.state = "unknown"
            raise
        result = {"done": True, "results": results, "sent": sum(r["outcome"] == "sent" for r in results)}
        entry.state, entry.result = "done", result
        warning = await run_in_threadpool(after, target, entry.change, results)
        if warning:
            result["warning"] = warning
        return result

    def after(target: central_api.Connection, batch: central_batch.Batch, results: list[dict]) -> str | None:
        """Links each creation with its source, reads Central again and writes the action log."""
        warning = None
        made = [r for r in results if r.get("outcome") == "sent" and r.get("id")]
        try:
            with database() as connection:
                for r in made:
                    if r.get("localId") and not clients.link_created(connection, r["localId"], r["id"]):
                        warning = "Creado en Central, pero algún cliente tuyo no se pudo enlazar: enlázalo con «Enlazar»."
                if made:
                    try:
                        central.refresh(connection, target)
                    except central.CentralError:
                        warning = warning or "Creado en Central, pero no se pudo volver a leer: pulsa «Actualizar» en Central."
                for r in made:
                    if r.get("crmdevId"):
                        try:
                            clients.set_pair_link(connection, r["id"], r["crmdevId"], "linked")
                        except clients.ClientError:
                            pass  # the same name pairs them on the next reading
                by_key = {o.key: o for o in batch.operations}
                with transaction(connection):
                    for r in results:
                        if r.get("outcome") == "sent":
                            op = by_key[r["key"]]
                            connection.execute(
                                "INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, 'usuario', 'crear_en_central', 'done', ?)",
                                (now(), json.dumps({"kind": "cliente-nuevo", "origin": op.origin, "fields": sorted(op.body), "from": "lote"}, ensure_ascii=False)))
        except (sqlite3.Error, OSError):
            LOG.warning("No se pudo anotar o enlazar un envío hecho a Central.")
            return "Creado en Central, pero no se pudo anotar en el registro de acciones de AgoraOne."
        return warning

    return router
