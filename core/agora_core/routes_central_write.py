"""HTTP routes that change Central from AgoraOne's own views, always in two steps and never anything that deletes:

- `GET /central/write/permissions`: whether the saved key may change Central (`escritura`, which brings `lectura`)
  and quote phases (also `presupuestos`); the screen shows its buttons only then, else how to get such a key.
- `POST /central/write/preview`: the exact change (`central_write.plan` or, for «Crear en Central», `new_client`),
  field by field before and after, checked against what Central has now; with a single-use token for it.
- `POST /central/write/confirm` `{token}`: sends that change, exactly the body kept with the token, once.

The token is reserved before anything is awaited, so two presses at once never send twice; a change of the same
thing (a client, a project, a phase) is never sent while another one is under way. A conflict (someone changed it
in Central since it was read) is a 409 with what Central has now, and the token is spent: the user reviews again
(nothing is retried by itself). When Central could not be heard to the end, a creation is marked «unknown» and never
sent again with that token; a change with its version may be pressed again (Central refuses it if it was applied).

The «Central» module off → 404 for clients, notes and projects; the «Presupuestos» module off → 404 for quote
phases. Without a key with the permission, 403 without asking Central for anything but its `estado`. Watson has
no tool that reaches these routes. Never the key, Central's address nor the values changed in an answer of error or
in the action log (only the names of the fields)."""

import hashlib
import json
import logging
import secrets as random
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import central_api, central_write, clients, modules
from .db import DB_NAME, connect, now, transaction
from .settings import Settings

OFF = {"central": "El módulo Central está apagado.", "presupuestos": "El módulo Presupuestos está apagado."}
NOT_CONNECTED = "Central no está conectado por su dirección y clave: conéctalo en Ajustes › Central."
NO_WRITE = ("La clave de Central no tiene el permiso «escritura»: crea en Ajustes › Apps conectadas de Central una clave con ese permiso "
            "y guárdala en Ajustes › Central.")
NO_QUOTES = ("Para cambiar los hitos de un presupuesto, la clave de Central necesita los permisos «escritura» y «presupuestos»: créala en "
             "Ajustes › Apps conectadas de Central y guárdala en Ajustes › Central.")
EXPIRED = "Esa vista previa ya no vale: vuelve a revisar el cambio."
UNKNOWN = "Central no respondió a tiempo y puede haberse creado: revisa en Central antes de repetirlo."
MOVED = "La conexión con Central ha cambiado desde la vista previa: vuelve a revisar el cambio."
SENDING = "Ese cambio ya se está enviando a Central."
BUSY_TARGET = "Hay otro cambio de esto enviándose a Central: espera a que termine y revisa otra vez."
STATUS_CODES = {"forbidden": 403, "not_found": 404, "invalid": 422, "config": 502, "auth": 502, "busy": 503}
TOKEN_SECONDS = 900
MAX_TOKENS = 200
LOG = logging.getLogger(__name__)


class PreviewIn(BaseModel):
    # Checked field by field in central_write (each kind allows its own keys): unknown ones are refused there.
    model_config = {"extra": "allow"}
    kind: str = Field(max_length=20)


class ConfirmIn(BaseModel):
    model_config = {"extra": "forbid"}
    token: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


@dataclass
class Pending:
    change: central_write.Change
    at: float
    central: str  # the Central (address and key) it was previewed against: sent only there
    state: str = "ready"  # ready, sending, done or unknown
    result: dict | None = None


def module_of(kind: str) -> str:
    return "presupuestos" if kind == "fase" else "central"


def central_of(target: central_api.Connection) -> str:
    """A fingerprint of the Central and key a change is for (never kept nor shown: only compared in memory)."""
    return hashlib.sha256(f"{central_api.origin(target.url)}|{target.key}".encode()).hexdigest()


def central_write_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()
    pending: dict[str, Pending] = {}
    busy: set[str] = set()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def with_db(work):
        with database() as connection:
            return work(connection)

    def problem(status: int, message: str, kind: str, **extra) -> JSONResponse:
        return JSONResponse({"error": message, "status": kind, **extra}, status_code=status)

    def failed(error: central_api.CentralApiError, kind: str) -> JSONResponse:
        if error.status == "forbidden":
            return problem(403, NO_QUOTES if kind == "fase" else NO_WRITE, "forbidden")
        return problem(STATUS_CODES.get(error.status, 502), str(error), error.status)

    def prepare(module: str) -> tuple[bool, central_api.Connection | None]:
        def work(connection):
            if not modules.state(connection)[module]:
                return False, None
            return True, central_api.connection_of(connection, secrets)
        return with_db(work)

    def allowed(target: central_api.Connection, kind: str) -> bool:
        scopes = set(central_api.status(target)["scopes"])
        need = {"escritura", "lectura", "presupuestos"} if kind == "fase" else {"escritura", "lectura"}
        return need <= scopes

    def forget_old() -> None:
        limit = time.time() - TOKEN_SECONDS
        for token in [t for t, p in pending.items() if p.at < limit and p.state != "sending"]:
            pending.pop(token, None)
        while len(pending) > MAX_TOKENS:
            oldest = next((t for t, p in pending.items() if p.state != "sending"), None)
            if oldest is None:
                break
            pending.pop(oldest)

    @router.get("/central/write/permissions")
    async def permissions(request: Request):
        """What the screen may offer: changes in the «Central» section and in quote phases."""
        if request.query_params:
            return problem(422, "Esta ruta no admite parámetros.", "invalid")

        def look(connection):
            state = modules.state(connection)
            return state["central"], state["presupuestos"], central_api.connection_of(connection, secrets)
        central_on, quotes_on, target = await run_in_threadpool(with_db, look)
        if not central_on and not quotes_on:
            return problem(404, OFF["central"], "off")
        if target is None:
            return {"central": False, "quotes": False, "problem": NOT_CONNECTED, "quotesProblem": NOT_CONNECTED}
        try:
            scopes = set((await run_in_threadpool(central_api.status, target))["scopes"])
        except central_api.CentralApiError as error:
            return failed(error, "cliente")
        writes = {"escritura", "lectura"} <= scopes
        quotes = writes and "presupuestos" in scopes
        return {"central": central_on and writes, "quotes": quotes_on and quotes,
                "problem": None if writes else NO_WRITE, "quotesProblem": None if quotes else NO_QUOTES}

    @router.post("/central/write/preview")
    async def preview(body: PreviewIn):
        given = body.model_dump()
        kind = given.get("kind")
        if kind not in central_write.KINDS:
            return problem(422, "Ese cambio no existe.", "invalid")
        on, target = await run_in_threadpool(prepare, module_of(kind))
        if not on:
            return problem(404, OFF[module_of(kind)], "off")
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")

        def work():
            if not allowed(target, kind):
                raise central_api.CentralApiError("forbidden", "")
            if kind == "cliente-nuevo":
                return with_db(lambda connection: central_write.new_client(connection, target, given))
            return central_write.plan(target, given)
        try:
            change = await run_in_threadpool(work)
        except central_write.ChangeError as error:
            return problem(422, str(error), "invalid")
        except central_write.ExistsError as error:
            return problem(409, str(error), "exists", centralId=error.central_id, centralName=error.name)
        except central_write.StaleError as error:
            return problem(409, str(error), "conflict", current=error.current)
        except central_api.CentralApiError as error:
            return failed(error, kind)
        forget_old()
        token = random.token_urlsafe(24)
        pending[token] = Pending(change, time.time(), central_of(target))
        return {"token": token, **change.public()}

    @router.post("/central/write/confirm")
    async def confirm(body: ConfirmIn):
        # From here to the reservation nothing is awaited: two presses at once can never both pass.
        forget_old()
        entry = pending.get(body.token)
        if entry is None:
            return problem(410, EXPIRED, "expired")
        if entry.state == "done":
            return {**(entry.result or {}), "repeated": True}
        if entry.state == "sending":
            return problem(409, SENDING, "repeated")
        if entry.state == "unknown":
            return problem(409, UNKNOWN, "unknown")
        change = entry.change
        if change.target in busy:
            return problem(409, BUSY_TARGET, "repeated")
        entry.state = "sending"
        busy.add(change.target)
        try:
            return await send(body.token, entry)
        finally:
            busy.discard(change.target)
            if entry.state == "sending":  # an unexpected failure: the change is reviewed again
                pending.pop(body.token, None)

    async def send(token: str, entry: Pending):
        change = entry.change
        on, target = await run_in_threadpool(prepare, module_of(change.kind))
        if not on or target is None:
            pending.pop(token, None)
            return problem(404, OFF[module_of(change.kind)], "off") if not on else problem(409, NOT_CONNECTED, "not_connected")
        if central_of(target) != entry.central:
            pending.pop(token, None)
            return problem(409, MOVED, "expired")
        if change.local_id is not None:
            own = await run_in_threadpool(with_db, lambda c: clients.get(c, change.local_id))
            if own is None or own["centralId"]:
                pending.pop(token, None)
                return problem(409, "Ese cliente ya no está en AgoraOne o ya está enlazado con uno de Central.", "repeated")
        try:
            data = await run_in_threadpool(central_api.write, target, change.method, change.path, change.body)
        except central_api.CentralConflict as error:
            pending.pop(token, None)
            return problem(409, conflict_message(error, change), error.kind, current=central_write.shown_now(change.kind, error.current))
        except central_api.CentralApiError as error:
            if error.status == "busy" or (change.method == "PATCH" and error.status in ("unreachable", "error")):
                entry.state = "ready"  # nothing written, or a version Central would refuse if it was: the user may press again
            elif error.status in ("unreachable", "error"):
                entry.state = "unknown"  # Central may have created it: never twice, and said so from the first answer
                return problem(502, UNKNOWN, "unknown")
            else:
                pending.pop(token, None)
            return failed(error, change.kind)
        result = {"done": True, "kind": change.kind, "title": change.title}
        warning = await run_in_threadpool(with_db, lambda c: record(c, change, data))
        if warning:
            result["warning"] = warning
        entry.state, entry.result = "done", result
        return result

    def record(connection: sqlite3.Connection, change: central_write.Change, data: dict) -> str | None:
        """Links a client created from one kept here and writes down what was changed (field names, never values)."""
        warning = None
        if change.local_id is not None:
            made = data.get("client") if isinstance(data.get("client"), dict) else {}
            central_id = made.get("id") if isinstance(made.get("id"), str) and central_write.ID.fullmatch(made["id"]) else None
            try:
                if central_id is None or not clients.link_created(connection, change.local_id, central_id):
                    warning = "Creado en Central, pero no se pudo enlazar con tu cliente: enlázalos con «Enlazar» tras volver a leer Central."
            except sqlite3.Error:
                warning = "Creado en Central, pero no se pudo enlazar con tu cliente: enlázalos con «Enlazar» tras volver a leer Central."
        try:
            with transaction(connection):
                connection.execute("INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, 'usuario', ?, 'done', ?)",
                                   (now(), "crear_en_central" if change.method == "POST" else "cambiar_en_central",
                                    json.dumps({"kind": change.kind, "fields": change.fields(), "from": "vista"}, ensure_ascii=False)))
        except (sqlite3.Error, OSError):
            LOG.warning("No se pudo anotar en el registro de acciones un cambio hecho en Central.")
            warning = warning or "Hecho en Central, pero no se pudo anotar en el registro de acciones de AgoraOne."
        return warning

    return router


def conflict_message(error: central_api.CentralConflict, change: central_write.Change) -> str:
    if error.kind == "duplicate":
        return "Ya hay un cliente con ese nombre en Central: no se ha cambiado nada." + (
            " Vuelve a leer Central y enlázalo con el tuyo." if change.local_id is not None else "")
    if error.kind == "status_locked":
        return "El estado de este proyecto está fijado a mano en Central y ha cambiado mientras tanto: no se ha cambiado nada. Revísalo otra vez."
    return "Ha cambiado en Central desde que lo leíste: no se ha cambiado nada. Esto es lo que hay ahora; vuelve a revisar el cambio."
