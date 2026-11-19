"""HTTP routes of the connectors (`connectors.py`): the list with each one's state, and reading, saving, testing and
forgetting one. They answer with any module off, so a connector can always be connected or disconnected. Bodies are
read by hand and capped: a validation error never echoes what was sent (it could carry a key), and a key is never
answered back."""

import json
from contextlib import contextmanager

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import connectors
from .db import DB_NAME, connect
from .settings import Settings

MAX_BODY = 4096
UNKNOWN = "Ese conector no existe."
BAD_BODY = "La petición no es válida: se esperaba un objeto JSON."


def connectors_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter(prefix="/connectors")

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

    def problem(status: int, message: str, kind: str | None = None) -> JSONResponse:
        return JSONResponse({"error": message, **({"status": kind} if kind else {})}, status_code=status)

    async def body_of(request: Request) -> dict | None:
        """The JSON object sent (an empty body is an empty object), or None when it is anything else."""
        declared = request.headers.get("content-length")
        if declared is not None and not (declared.isascii() and declared.isdigit() and int(declared) <= MAX_BODY):
            return None  # refused before reading
        raw = bytearray()
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > MAX_BODY:
                return None
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    @router.get("")
    async def list_connectors():
        return {"connectors": await db(lambda c: connectors.describe_all(c, secrets))}

    @router.get("/{connector_id}")
    async def one(connector_id: str):
        """Only that connector's state: nothing of the others is checked."""
        connector = connectors.REGISTRY.get(connector_id)
        if connector is None:
            return problem(404, UNKNOWN)
        return await db(lambda c: connectors.describe(connector, c, secrets))

    @router.put("/{connector_id}")
    async def save(connector_id: str, request: Request):
        connector = connectors.REGISTRY.get(connector_id)
        if connector is None:
            return problem(404, UNKNOWN)
        body = await body_of(request)
        if body is None:
            return problem(422, BAD_BODY)
        def work(connection):
            connector.adapter.save(connection, secrets, body)
            return connectors.describe(connector, connection, secrets)
        try:
            return await db(work)
        except connectors.ConnectorError as error:
            return problem(error.status, str(error))

    @router.post("/{connector_id}/test")
    async def test(connector_id: str, request: Request):
        connector = connectors.REGISTRY.get(connector_id)
        if connector is None:
            return problem(404, UNKNOWN)
        body = await body_of(request)
        if body is None:
            return problem(422, BAD_BODY)
        try:
            return await db(lambda c: connector.adapter.test(c, secrets, body))
        except connectors.ConnectorError as error:
            return problem(error.status, str(error), error.kind)

    @router.delete("/{connector_id}")
    async def forget(connector_id: str):
        connector = connectors.REGISTRY.get(connector_id)
        if connector is None:
            return problem(404, UNKNOWN)
        def work(connection):
            connector.adapter.forget(connection, secrets)
            return connectors.describe(connector, connection, secrets)
        try:
            return await db(work)
        except connectors.ConnectorError as error:
            return problem(error.status, str(error))

    return router
