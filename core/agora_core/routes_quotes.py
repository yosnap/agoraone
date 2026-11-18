"""HTTP routes of the «Presupuestos» module: `GET /quotes` (filters `cliente` and `estado`), `GET /quotes/rates`,
`GET /quotes/{id}`, `POST /quotes/{id}/open?format=pdf|docx` and `POST /quotes` (a new draft). Read live from
Central's API with the saved connection; the module needs a key with the `presupuestos` permission, not the
«Central» module.

With the «Presupuestos» module off every route answers 404 before looking at anything. A request out of shape is a
422 without asking Central; without an HTTP connection, 409 `not_connected`; a key without the permission, 403 in
plain words with where to fix it; Central failing, 502. Never the key nor Central's address in an answer.

A draft is created only with the form's single-use token, tied to a hash of what is sent: a second send of the same
content with the same token never creates another one (it gets the first answer back, or 409 while the first is under
way or when it is unknown whether Central created it); other content is another draft. Always a draft: nothing here sends a quote nor changes a state."""

import hashlib
import json
import logging
import sqlite3
import time
from contextlib import contextmanager

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from . import central, central_api, central_quotes, clients, modules
from .central_views import ID, ViewError
from .db import DB_NAME, connect, now, transaction
from .settings import Settings

OFF = "El módulo Presupuestos está apagado."
NOT_CONNECTED = "Presupuestos necesita Central conectado por su dirección y clave: conéctalo en Ajustes › Central."
NO_PERMISSION = ("La clave de Central no tiene el permiso «presupuestos»: crea en Ajustes › Apps conectadas de Central una con ese permiso "
                 "y guárdala en Ajustes › Central.")
BAD_ID = "El identificador del presupuesto no es válido."
NOT_IN_CENTRAL = "Ese cliente no está en Central: es un cliente propio de AgoraOne. Créalo antes en Central para hacerle un presupuesto."
STATUS_CODES = {"forbidden": 403, "not_found": 404, "invalid": 422}
TOKEN_SECONDS = 86400
MAX_TOKENS = 500
MAX_BODY = 256 * 1024  # Central's own limit for a draft
LOG = logging.getLogger(__name__)


def quotes_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()
    # Single-use tokens of the draft form: when it was used and what Central answered (None while it is being
    # created, "unknown" when Central could not be heard to the end).
    tokens: dict[str, tuple[float, dict | str | None]] = {}

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def problem(status: int, message: str, kind: str) -> JSONResponse:
        return JSONResponse({"error": message, "status": kind}, status_code=status)

    def failed(error: central_api.CentralApiError) -> JSONResponse:
        if error.status == "forbidden":
            return problem(403, NO_PERMISSION, "forbidden")
        return problem(STATUS_CODES.get(error.status, 502), str(error), error.status)

    def prepare() -> tuple[bool, central_api.Connection | None]:
        with database() as connection:
            if not modules.state(connection)["presupuestos"]:
                return False, None
            return True, central_api.connection_of(connection, secrets)

    async def answer(check, work):
        """Module off → 404; out of shape → 422; no connection → 409; Central or this computer failing → its code."""
        on, target = await run_in_threadpool(prepare)
        if not on:
            return problem(404, OFF, "off")
        refused = check()
        if refused is not None:
            return refused
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")
        try:
            return await run_in_threadpool(work, target)
        except central_api.CentralApiError as error:
            return failed(error)
        except central_quotes.DocumentError as error:
            return problem(503, str(error), "local")

    def no_query(request: Request):
        return problem(422, "Esta ruta no admite parámetros.", "invalid") if request.query_params else None

    def valid_id(item: str):
        return None if ID.fullmatch(item) else problem(422, BAD_ID, "invalid")

    @router.get("/quotes")
    async def list_quotes(request: Request):
        query: dict = {}

        def check():
            try:
                query.update(central_quotes.list_params(dict(request.query_params)))
            except ViewError as error:
                return problem(422, str(error), "invalid")
            return None
        return await answer(check, lambda target: central_quotes.read_list(target, query))

    @router.get("/quotes/rates")
    async def rates(request: Request):
        return await answer(lambda: no_query(request), central_quotes.read_rates)

    # «path» so that an id with «/» reaches the check (422) instead of missing the route.
    @router.get("/quotes/{item:path}")
    async def one_quote(item: str, request: Request):
        return await answer(lambda: valid_id(item) or no_query(request), lambda target: central_quotes.read_item(target, item))

    @router.post("/quotes/{item}/open")
    async def open_document(item: str, request: Request):
        kind: list[str] = []

        def check():
            refused = valid_id(item)
            if refused is not None:
                return refused
            try:
                kind.append(central_quotes.document_format(dict(request.query_params)))
            except ViewError as error:
                return problem(422, str(error), "invalid")
            return None

        def work(target):
            name = central_quotes.open_document(target, item, kind[0], settings.data_dir)
            return {"opened": name, "format": kind[0]}
        return await answer(check, work)

    def forget_old() -> None:
        limit = time.time() - TOKEN_SECONDS
        for token in [t for t, (at, _) in tokens.items() if at < limit]:
            tokens.pop(token, None)
        while len(tokens) > MAX_TOKENS:
            tokens.pop(next(iter(tokens)))

    def own_only(connection: sqlite3.Connection, name: str) -> bool:
        """The client is one of the user's own and Central (read before) has none by that name or alias."""
        if central.snapshot(connection) is None:
            return False  # without a reading of Central's clients (or with that module off), Central itself says it
        wanted = name.casefold()
        found = [e for e in clients.directory(connection) if wanted in {n.casefold() for n in (e["name"], *e.get("aliases", []))}]
        return bool(found) and all(e["source"] == "local" for e in found)

    async def bounded_body(request: Request) -> bytes | None:
        """The body, or None as soon as it is larger than Central accepts (never read whole first)."""
        declared = request.headers.get("content-length")
        if declared is not None and (not (declared.isascii() and declared.isdigit()) or int(declared) > MAX_BODY):
            return None
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BODY:
                return None
            chunks.append(chunk)
        return b"".join(chunks)

    @router.post("/quotes", status_code=201)
    async def create_draft(request: Request):
        on, target = await run_in_threadpool(prepare)
        if not on:
            return problem(404, OFF, "off")
        raw = await bounded_body(request)
        if request.query_params or raw is None:
            return problem(422, "El borrador no es válido.", "invalid")
        try:
            given = json.loads(raw)
        except ValueError:
            return problem(422, "El borrador no es válido.", "invalid")
        token = given.get("token") if isinstance(given, dict) else None
        if not isinstance(token, str) or not 16 <= len(token) <= 64 or not token.isascii() or not all(c.isalnum() or c in "-_" for c in token):
            return problem(422, "Falta el identificador del formulario: vuelve a abrirlo.", "invalid")
        if set(given) != {"token", "quote"}:
            return problem(422, "El borrador no es válido.", "invalid")
        try:
            draft = central_quotes.Draft.model_validate(given["quote"])
        except ValidationError as error:
            return problem(422, central_quotes.draft_problem(error.errors()), "invalid")
        body = draft.body()
        # The token goes with what is sent: the same form sent again with other content is another draft.
        sent = token + ":" + hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        # From here to the reservation there is no wait: two sends at once can never both pass.
        forget_old()
        seen = tokens.get(sent)
        if seen is not None:
            if isinstance(seen[1], dict):
                return JSONResponse({"created": seen[1], "repeated": True}, status_code=200)
            message = ("Ese borrador ya se está creando." if seen[1] is None
                       else "No se sabe si Central llegó a crearlo: vuelve a leer la lista antes de intentarlo otra vez.")
            return problem(409, message, "repeated")
        if target is None:
            return problem(409, NOT_CONNECTED, "not_connected")
        tokens[sent] = (time.time(), None)
        if await run_in_threadpool(lambda: _with(database, lambda c: own_only(c, draft.client))):
            tokens.pop(sent, None)  # refused before asking Central: nothing was created
            return problem(422, NOT_IN_CENTRAL, "not_in_central")
        try:
            made = await run_in_threadpool(central_api.create_quote, target, body)
        except central_api.CentralApiError as error:
            if error.status in ("unreachable", "error"):
                tokens[sent] = (time.time(), "unknown")  # Central may have created it: never twice
            else:
                tokens.pop(sent, None)  # refused: nothing was created, the user may fix it and send again
            return failed(error)
        tokens[sent] = (time.time(), made)

        def log(connection):
            with transaction(connection):
                connection.execute("INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, 'usuario', 'crear_presupuesto', 'done', ?)",
                                   (now(), json.dumps({"number": made.get("number"), "from": "formulario"}, ensure_ascii=False)))
        try:
            await run_in_threadpool(_with, database, log)
        except (sqlite3.Error, OSError):
            # The draft exists in Central: that is the answer, with a note that it was not written down here.
            LOG.warning("No se pudo anotar en el registro de acciones el borrador creado en Central.")
            return {"created": made, "warning": "Creado en Central, pero no se pudo anotar en el registro de acciones de AgoraOne."}
        return {"created": made}

    return router


def _with(database, work):
    with database() as connection:
        return work(connection)
