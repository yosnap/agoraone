"""HTTP routes that create or change things in CRMDev from the «CRMDev» section, always in two steps and never anything
that deletes:

- `POST /crmdev/write/preview`: the exact change (`crmdev_write.plan`), field by field before and after, read from
  CRMDev now; with a single-use token for it.
- `POST /crmdev/write/confirm` `{token}`: reads the record again and, if what was shown as «before» is still there,
  sends exactly the arguments kept with the token, once, with the tool fixed by the kind of change (`KIND_TOOL`).

Tokens, the reservation and repeated presses are `confirmed_change`'s. The body of a preview is read by hand (capped,
and each kind checks its own keys in crmdev_write), so anything out of shape is a 422 in the core's own words. After a
creation whose answer never came, a new preview of the same one is refused (409 `doubtful`) until the user, having
looked in CRMDev, asks for it with `anyway` («Crear de todos modos»). The screen never names a tool: a body naming
one is refused before anything is asked. A change already in CRMDev (found so on confirming) is not sent again. When
CRMDev could not be heard to the end, a creation is marked «unknown» and never sent again with that token; a change of
a record may be pressed again (it is read again first). After a change, the readings it makes old are forgotten.

The «CRMDev» module off → 404, without a connection → 409. Watson has no tool that reaches these routes, and nothing
from CRMDev, the mail or any text triggers them: only a form the user fills and confirms. Never the key, CRMDev's
address nor the values changed in an answer of error or in the action log (only the names of the fields)."""

import hashlib
import json
import logging
import sqlite3
import time
from contextlib import contextmanager

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import crmdev_api, crmdev_write, modules, web_api
from .confirmed_change import ChangeError, Pending, PendingChanges, Refused, Sentences
from .db import DB_NAME, connect, now, transaction
from .settings import Settings

OFF = "El módulo CRMDev está apagado."
NOT_CONNECTED = "Conecta CRMDev en Conectores › CRMDev."
EXPIRED = "Esa vista previa ya no vale: vuelve a revisar el cambio."
UNKNOWN = "CRMDev no respondió a tiempo y puede haberse creado: revisa en CRMDev antes de repetirlo."
MOVED = "La conexión con CRMDev ha cambiado desde la vista previa: vuelve a revisar el cambio."
SENDING = "Ese cambio ya se está enviando a CRMDev."
BUSY_TARGET = "Hay otro cambio de esto enviándose a CRMDev: espera a que termine y revisa otra vez."
DOUBTFUL = ("Un intento anterior de crear esto no recibió respuesta de CRMDev y puede haberse creado: revisa en CRMDev si ya está antes de "
            "crearlo otra vez.")
ANYWAY = "Un intento anterior pudo crearlo ya: si sigues, puede quedar repetido en CRMDev."
CREATIONS = frozenset({"tarea-nueva", "cliente-nuevo"})
DOUBT_SECONDS = 24 * 3600
MAX_BODY = 64 * 1024
STATUS_CODES = {"forbidden": 403, "not_found": 404, "invalid": 422, "busy": 429, "config": 409}
TOKEN_SECONDS = 900
MAX_TOKENS = 200
LOG = logging.getLogger(__name__)


class ConfirmIn(BaseModel):
    model_config = {"extra": "forbid"}
    token: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


def owner_of(target: web_api.Connection) -> str:
    """A fingerprint of the CRMDev and key a change is for (never kept nor shown: only compared in memory)."""
    return hashlib.sha256(f"{target.url}|{target.key}".encode()).hexdigest()


def crmdev_write_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()
    pending: PendingChanges[crmdev_write.Change] = PendingChanges(Sentences(EXPIRED, SENDING, UNKNOWN, BUSY_TARGET), TOKEN_SECONDS, MAX_TOKENS)
    doubtful: dict[str, float] = {}  # creations whose answer never came (target → when): a new one of the same asks first

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
        # Fixed sentences of web_api/crmdev_api (CRMDev's own reason has the key scrubbed): no URL nor key.
        return problem(STATUS_CODES.get(error.status, 502), str(error), error.status)

    def prepare() -> tuple[bool, web_api.Connection | None]:
        with database() as connection:
            if not modules.state(connection)["crmdev"]:
                return False, None
            return True, crmdev_api.connection_of(connection, secrets)

    def doubtful_of(target_id: str) -> bool:
        cutoff = time.time() - DOUBT_SECONDS
        for old in [t for t, at in doubtful.items() if at < cutoff]:
            doubtful.pop(old, None)
        return target_id in doubtful

    def doubt(target_id: str) -> None:
        doubtful[target_id] = time.time()
        while len(doubtful) > MAX_TOKENS:
            doubtful.pop(next(iter(doubtful)))

    @router.post("/crmdev/write/preview")
    async def preview(request: Request):
        raw = await request.body()
        if len(raw) > MAX_BODY:
            return problem(413, "El cambio es demasiado grande.", "invalid")
        try:
            given = json.loads(raw)
        except ValueError:
            return problem(422, "El cambio no se entiende.", "invalid")
        if not isinstance(given, dict) or not isinstance(given.get("kind"), str) or given["kind"] not in crmdev_write.KINDS:
            return problem(422, "Ese cambio no existe.", "invalid")
        creation = given["kind"] in CREATIONS
        # «Crear de todos modos», only for a creation whose earlier try may already be in CRMDev; anywhere else refused.
        anyway = given.pop("anyway", None) is True if creation else False
        on, target = await run_in_threadpool(prepare)
        if not on:
            return problem(404, OFF, "off")
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")
        try:
            change = await run_in_threadpool(crmdev_write.plan, target, given)
        except ChangeError as error:
            return problem(422, str(error), "invalid")
        except crmdev_write.ExistsError as error:
            return problem(409, str(error), "exists", crmdevId=error.crmdev_id, crmdevName=error.name)
        except web_api.WebApiError as error:
            return failed(error)
        if creation and doubtful_of(change.target):
            if not anyway:
                return problem(409, DOUBTFUL, "doubtful")
            change.warnings.append(ANYWAY)
        token = pending.preview(change, owner_of(target))
        return {"token": token, **change.public()}

    @router.post("/crmdev/write/confirm")
    async def confirm(body: ConfirmIn):
        try:
            return await pending.confirm(body.token, send)
        except Refused as refused:
            return problem(refused.status, str(refused), refused.kind)

    async def send(token: str, entry: Pending[crmdev_write.Change]):
        change = entry.change
        creation = change.kind in CREATIONS
        on, target = await run_in_threadpool(prepare)
        if not on or target is None:
            pending.drop(token)
            return problem(404, OFF, "off") if not on else problem(409, NOT_CONNECTED, "not_connected")
        if owner_of(target) != entry.owner:
            pending.drop(token)
            return problem(409, MOVED, "expired")
        try:
            already = await run_in_threadpool(crmdev_write.check, target, change)
        except crmdev_write.StaleError as error:
            pending.drop(token)
            crmdev_api.forget_reads(crmdev_write.KIND_LISTS[change.kind])  # the screen reads what there is now
            return problem(409, str(error), "conflict", current=error.current)
        except crmdev_write.ExistsError as error:
            pending.drop(token)
            return problem(409, str(error), "exists", crmdevId=error.crmdev_id, crmdevName=error.name)
        except web_api.WebApiError as error:
            if error.status == "busy":
                entry.state = "ready"  # nothing was sent: the user may press again
            else:
                pending.drop(token)
            return failed(error)
        if not already:
            try:
                # The tool comes from the kind of change, fixed in the core; the closed list checks it again.
                await run_in_threadpool(crmdev_api.call, target, crmdev_write.KIND_TOOL[change.kind], change.arguments)
            except web_api.WebApiError as error:
                if error.status != "busy":
                    crmdev_api.forget_reads(crmdev_write.KIND_LISTS[change.kind])  # it may have been written: read it anew
                if error.status == "busy" or (not creation and error.status in ("unreachable", "error")):
                    entry.state = "ready"  # nothing written, or a change that is read again before sending: may be pressed again
                elif error.status in ("unreachable", "error"):
                    entry.state = "unknown"  # CRMDev may have created it: never twice, and said so from the first answer
                    doubt(change.target)
                    return problem(502, UNKNOWN, "unknown")
                else:
                    pending.drop(token)
                return failed(error)
            except Exception:
                if creation:  # an unexpected failure once it may have left: treated as «may have been created»
                    entry.state = "unknown"
                    doubt(change.target)
                raise
        # Done before anything else can fail, so an error afterwards never lets the same change be sent again.
        result = {"done": True, "kind": change.kind, "title": change.title}
        entry.state, entry.result = "done", result
        doubtful.pop(change.target, None)
        crmdev_api.forget_reads(crmdev_write.KIND_LISTS[change.kind])
        warning = await run_in_threadpool(record, change, already)
        if warning:
            result["warning"] = warning
        return result

    def record(change: crmdev_write.Change, already: bool) -> str | None:
        """Writes down what was created or changed in CRMDev (field names, never values); `already` when CRMDev had it
        so and nothing was sent."""
        try:
            with database() as connection, transaction(connection):
                connection.execute("INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, 'usuario', ?, 'done', ?)",
                                   (now(), "crear_en_crmdev" if change.kind in CREATIONS else "cambiar_en_crmdev",
                                    json.dumps({"kind": change.kind, "fields": change.fields(), "from": "vista", **({"already": True} if already else {})},
                                               ensure_ascii=False)))
        except (sqlite3.Error, OSError):
            LOG.warning("No se pudo anotar en el registro de acciones un cambio hecho en CRMDev.")
            return "Hecho en CRMDev, pero no se pudo anotar en el registro de acciones de AgoraOne."
        return None

    return router
