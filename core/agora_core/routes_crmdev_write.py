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

«Crear en CRMDev» of a client kept only in AgoraOne (`cliente-desde-local`, from Trabajos › Clientes) is one more
creation: once created, the client kept here is linked with the new one and CRMDev's clients are read again.

A preview may say the organization of CRMDev (`org`, the first one when not said): the change is read, checked and sent
with that organization's key, and an organization AgoraOne does not know is a 409 `no_org`.

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

from . import clients, crmdev_api, crmdev_orgs, crmdev_sync, crmdev_write, modules, web_api
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
CREATIONS = frozenset({"tarea-nueva", "cliente-nuevo", "cliente-desde-local", "respuesta-ticket"})
NOT_LINKED = "Creado en CRMDev, pero no se pudo enlazar con tu cliente: enlázalos con «Enlazar» tras actualizar los clientes de CRMDev."
NO_ORG = "Esa organización de CRMDev ya no está: elige otra."
REPEATED_LOCAL = "Ese cliente ya no está en AgoraOne o ya está enlazado con uno de CRMDev."
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

    def prepare(org: str | None = None) -> tuple[bool, web_api.Connection | None]:
        with database() as connection:
            if not modules.state(connection)["crmdev"]:
                return False, None
            return True, crmdev_orgs.connection_of(connection, secrets, org)

    def known(org: str | None) -> bool:
        with database() as connection:
            return org is None or crmdev_orgs.known(connection, org)

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
        org = given.pop("org", None)
        if org is not None and (not isinstance(org, str) or not crmdev_orgs.ID.fullmatch(org)):
            return problem(422, "Esa organización no es válida.", "invalid")
        on, target = await run_in_threadpool(prepare, org)
        if not on:
            return problem(404, OFF, "off")
        if not await run_in_threadpool(known, org):
            return problem(409, NO_ORG, "no_org")
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")
        def plan():
            if given["kind"] == "cliente-desde-local":
                with database() as connection:
                    return crmdev_write.from_local(connection, target, given)
            return crmdev_write.plan(target, given)
        try:
            change = await run_in_threadpool(plan)
        except ChangeError as error:
            return problem(422, str(error), "invalid")
        except crmdev_write.ExistsError as error:
            return problem(409, str(error), "exists", crmdevId=error.crmdev_id, crmdevName=error.name)
        except web_api.WebApiError as error:
            return failed(error)
        if creation and doubtful_of(f"{org}|{change.target}"):
            if not anyway:
                return problem(409, DOUBTFUL, "doubtful")
            change.warnings.append(ANYWAY)
        change.org = org
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
        on, target = await run_in_threadpool(prepare, change.org)
        if not on or target is None:
            pending.drop(token)
            return problem(404, OFF, "off") if not on else problem(409, NOT_CONNECTED, "not_connected")
        if owner_of(target) != entry.owner:
            pending.drop(token)
            return problem(409, MOVED, "expired")
        if change.local_id is not None and not await run_in_threadpool(unlinked, change.local_id):
            pending.drop(token)
            return problem(409, REPEATED_LOCAL, "repeated")
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
        made: object = None
        if not already:
            try:
                # The tool comes from the kind of change, fixed in the core; the closed list checks it again.
                made = await run_in_threadpool(crmdev_api.call, target, crmdev_write.KIND_TOOL[change.kind], change.arguments)
            except web_api.WebApiError as error:
                if error.status != "busy":
                    crmdev_api.forget_reads(crmdev_write.KIND_LISTS[change.kind])  # it may have been written: read it anew
                if error.status == "busy" or (not creation and error.status in ("unreachable", "error")):
                    entry.state = "ready"  # nothing written, or a change that is read again before sending: may be pressed again
                elif error.status in ("unreachable", "error"):
                    entry.state = "unknown"  # CRMDev may have created it: never twice, and said so from the first answer
                    doubt(f"{change.org}|{change.target}")
                    return problem(502, UNKNOWN, "unknown")
                else:
                    pending.drop(token)
                return failed(error)
            except Exception:
                if creation:  # an unexpected failure once it may have left: treated as «may have been created»
                    entry.state = "unknown"
                    doubt(f"{change.org}|{change.target}")
                raise
        # Done before anything else can fail, so an error afterwards never lets the same change be sent again.
        result = {"done": True, "kind": change.kind, "title": change.title}
        entry.state, entry.result = "done", result
        doubtful.pop(f"{change.org}|{change.target}", None)
        crmdev_api.forget_reads(crmdev_write.KIND_LISTS[change.kind])
        warning = await run_in_threadpool(record, change, already)
        if change.local_id is not None and not already:
            warning = await run_in_threadpool(link_created, change.local_id, made, target, change.org) or warning
        if warning:
            result["warning"] = warning
        return result

    def unlinked(local_id: int) -> bool:
        with database() as connection:
            own = clients.get(connection, local_id)
        return own is not None and not any(link["connector"] == "crmdev" and link["state"] == "linked" for link in own["links"])

    def link_created(local_id: int, made: object, target: web_api.Connection, org: str | None) -> str | None:
        """Links the client kept here with the one just created in CRMDev and reads CRMDev's clients again, so the
        directory shows it once now. If the link fails, the next reading joins them by name: never a duplicate."""
        made_id = made.get("id") if isinstance(made, dict) else None
        if not isinstance(made_id, str) or not crmdev_api.ID.fullmatch(made_id):
            return NOT_LINKED
        try:
            with database() as connection:
                if not clients.link_remote(connection, local_id, "crmdev", made_id):
                    return NOT_LINKED
                try:
                    crmdev_sync.refresh(connection, target, org)
                except web_api.WebApiError:
                    pass  # read again on the next half hour or with «Actualizar»: the link is already kept
        except sqlite3.Error:
            return NOT_LINKED
        return None

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
