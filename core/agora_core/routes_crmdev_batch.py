"""HTTP routes of «Enviar a CRMDev» (`crmdev_batch`), in two steps like every change to CRMDev:

- `POST /crmdev/batch/preview` `{keys, anyway?}`: the exact operations for the ticked warnings of «Pendiente en
  CRMDev», read from CRMDev now, and what cannot go with its reason; with a single-use token valid 15 minutes.
- `POST /crmdev/batch/confirm` `{token}`: reads CRMDev again and sends what still applies, one write after another.
  A batch is sent once: afterwards a new review is needed. Each creation is linked with its Central record after
  reading CRMDev again; the action log keeps only kinds and field names.

A creation whose answer never came is not offered again for 24 hours unless the user asks with `anyway` after looking
in CRMDev. The «CRMDev» module off → 404, without a connection → 409. Watson has no tool that reaches these routes and
nothing CRMDev, Central or any text says triggers them. Never the key, CRMDev's address nor a value in an error or in
the log."""

import json
import logging
import re
import sqlite3
import time
from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import clients, crmdev_api, crmdev_batch, crmdev_sync, modules, project_links, web_api
from .confirmed_change import Pending, PendingChanges, Refused, Sentences
from .db import DB_NAME, connect, now, transaction
from .routes_crmdev_write import DOUBT_SECONDS, NOT_CONNECTED, OFF, STATUS_CODES, owner_of
from .settings import Settings

KEY = r"^[a-z_]{1,40}(?::[A-Za-z0-9_-]{1,100}){1,2}$"
EXPIRED = "Esa revisión ya no vale (caduca a los 15 minutos): vuelve a revisar el envío."
SENDING = "Ese envío ya está en marcha."
UNKNOWN = "Ese envío ya se hizo: revisa lo pendiente otra vez."
BUSY = "Hay otro envío a CRMDev en marcha: espera a que termine."
MOVED = "La conexión con CRMDev ha cambiado desde la revisión: vuelve a revisar el envío."
NOTHING = "Nada de lo marcado puede enviarse ahora."
TOKEN_SECONDS = 900
LOG = logging.getLogger(__name__)


class BatchIn(BaseModel):
    model_config = {"extra": "forbid"}
    keys: list[str] = Field(min_length=1, max_length=500)
    anyway: list[str] = Field(default_factory=list, max_length=500)


class ConfirmIn(BaseModel):
    model_config = {"extra": "forbid"}
    token: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


def crmdev_batch_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()
    pending: PendingChanges[crmdev_batch.Batch] = PendingChanges(Sentences(EXPIRED, SENDING, UNKNOWN, BUSY), TOKEN_SECONDS, 20)
    doubtful: dict[str, float] = {}

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def problem(status: int, message: str, kind: str, **extra) -> JSONResponse:
        return JSONResponse({"error": message, "status": kind, **extra}, status_code=status)

    def failed(error: web_api.WebApiError) -> JSONResponse:
        return problem(STATUS_CODES.get(error.status, 502), str(error), error.status)

    def prepare() -> tuple[bool, web_api.Connection | None]:
        with database() as connection:
            if not modules.state(connection)["crmdev"]:
                return False, None
            return True, crmdev_api.connection_of(connection, secrets)

    def is_doubtful(key: str) -> bool:
        cutoff = time.time() - DOUBT_SECONDS
        for old in [k for k, at in doubtful.items() if at < cutoff]:
            doubtful.pop(old, None)
        return key in doubtful

    def doubt(key: str) -> None:
        doubtful[key] = time.time()
        while len(doubtful) > 500:
            doubtful.pop(next(iter(doubtful)))

    @router.post("/crmdev/batch/preview")
    async def preview(body: BatchIn):
        if any(not re.fullmatch(KEY, key) for key in [*body.keys, *body.anyway]):
            return problem(422, "Un aviso no es válido.", "invalid")
        on, target = await run_in_threadpool(prepare)
        if not on:
            return problem(404, OFF, "off")
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")

        def plan():
            with database() as connection:
                return crmdev_batch.plan(connection, target, body.keys, is_doubtful, set(body.anyway))
        try:
            batch = await run_in_threadpool(plan)
        except web_api.WebApiError as error:
            return failed(error)
        if not batch.operations:
            return problem(422, NOTHING, "nothing", skipped=batch.skipped)
        return {"token": pending.preview(batch, owner_of(target)), **batch.public()}

    @router.post("/crmdev/batch/confirm")
    async def confirm(body: ConfirmIn):
        try:
            return await pending.confirm(body.token, send)
        except Refused as refused:
            return problem(refused.status, str(refused), refused.kind)

    async def send(token: str, entry: Pending[crmdev_batch.Batch]):
        on, target = await run_in_threadpool(prepare)
        if not on or target is None:
            pending.drop(token)
            return problem(404, OFF, "off") if not on else problem(409, NOT_CONNECTED, "not_connected")
        if owner_of(target) != entry.owner:
            pending.drop(token)
            return problem(409, MOVED, "expired")
        try:
            results = await run_in_threadpool(crmdev_batch.send, target, entry.change, doubt)
        except web_api.WebApiError as error:  # the first reading failed: nothing was sent
            entry.state = "ready"
            return failed(error)
        except Exception:
            entry.state = "unknown"  # it may have sent part of it: never again with this token
            raise
        result = {"done": True, "results": results, "sent": sum(r["outcome"] == "sent" for r in results)}
        entry.state, entry.result = "done", result  # a batch goes once, whatever happened
        warning = await run_in_threadpool(after, target, entry.change, results)
        if warning:
            result["warning"] = warning
        return result

    def after(target: web_api.Connection, batch: crmdev_batch.Batch, results: list[dict]) -> str | None:
        """Reads CRMDev again, links each creation with its Central record and writes the action log."""
        warning = None
        created = [r for r in results if r.get("outcome") == "sent" and r.get("id")]
        try:
            with database() as connection:
                if any(r.get("outcome") == "sent" for r in results):  # also a change: «Pendiente en CRMDev» shows what is now
                    try:
                        try:
                            crmdev_sync.refresh(connection, target)
                        except web_api.WebApiError as error:  # right after a batch CRMDev may ask to wait: once
                            if error.status != "busy":
                                raise
                            time.sleep(min(crmdev_batch.WAIT_CAP, max(1.0, crmdev_api.wait_seconds(target))))
                            crmdev_sync.refresh(connection, target)
                    except web_api.WebApiError:
                        warning = "Enviado, pero no se pudo volver a leer CRMDev: pulsa «Actualizar CRMDev» para ver los enlaces."
                for r in created:
                    try:
                        if r["kind"] == "crear-proyecto":
                            project_links.set_link(connection, r["centralId"], r["id"], "linked")
                        elif r["key"].startswith("client_missing:"):
                            clients.set_pair_link(connection, r["centralId"], r["id"], "linked")
                    except (project_links.ProjectLinkError, clients.ClientError):
                        pass  # the same name pairs them on the next reading
                with transaction(connection):
                    by_key = {o.key: o for o in batch.operations}
                    for r in results:
                        if r.get("outcome") in ("sent", "already"):
                            op = by_key[r["key"]]
                            connection.execute(
                                "INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, 'usuario', 'enviar_a_crmdev', 'done', ?)",
                                (now(), json.dumps({"kind": op.kind, "fields": sorted(row["field"] for row in op.rows),
                                                    **({"already": True} if r["outcome"] == "already" else {})}, ensure_ascii=False)))
        except (sqlite3.Error, OSError):
            LOG.warning("No se pudo anotar o enlazar un envío hecho a CRMDev.")
            return "Enviado a CRMDev, pero no se pudo anotar en el registro de acciones de AgoraOne."
        return warning

    return router
