"""HTTP routes of the assistant: settings, engines, keys and conversations answered by Server-Sent Events."""

import json
import re
import sqlite3
from collections.abc import Callable
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import assistant
from .db import DB_NAME, connect, now
from .embed import Embedder, VectorCache
from .engines import (
    SECRET_ACCOUNTS, AnthropicApiEngine, ClaudeCodeEngine, CompatibleEngine, Engine, EngineError, Turn, choose,
)
from .search import search
from .settings import Settings

_OWNER = re.compile(r"[a-f0-9]{64}")
HISTORY = 10
SOURCES = 6


class KeychainSecrets:
    def get(self, account: str) -> str | None:
        import keyring

        return keyring.get_password("AgoraOne", account)

    def put(self, account: str, value: str | None) -> None:
        import keyring

        if value is None:
            try:
                keyring.delete_password("AgoraOne", account)
            except keyring.errors.PasswordDeleteError:
                pass
        else:
            keyring.set_password("AgoraOne", account, value)


def default_engines(settings: dict, secrets) -> list[Engine]:
    compatible = settings["compatible"]
    return [ClaudeCodeEngine(), AnthropicApiEngine(secrets), CompatibleEngine(secrets, compatible["baseUrl"], compatible["model"])]


class MessageIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)


class KeyIn(BaseModel):
    key: str | None = Field(default=None, min_length=8, max_length=500)


class SettingsIn(BaseModel):
    persona: str | None = None
    model: str | None = None
    engine: str | None = None
    tone: dict[str, str] | None = None
    compatible: dict[str, str | None] | None = None


def _event(kind: str, data) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def assistant_router(
    settings: Settings, embedder: Embedder | None, cache: VectorCache, secrets,
    engines: Callable[[dict, object], list[Engine]] = default_engines,
) -> APIRouter:
    router = APIRouter(prefix="/assistant")

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def owner_of(request: Request) -> str | None:
        owner = request.headers.get("x-agora-owner", "")
        return owner if _OWNER.fullmatch(owner) else None

    def owned(connection: sqlite3.Connection, conversation_id: int, owner: str):
        return connection.execute(
            "SELECT * FROM conversation WHERE id = ? AND owner = ?", (conversation_id, owner)
        ).fetchone()

    @router.get("/personas")
    async def list_personas():
        return {"personas": assistant.personas(), "tone": {k: list(v) for k, v in assistant.TONE_OPTIONS.items()}}

    @router.get("/settings")
    async def get_settings():
        with database() as connection:
            return assistant.load_settings(connection)

    @router.put("/settings")
    async def put_settings(body: SettingsIn):
        changes = body.model_dump(exclude_unset=True)
        try:
            with database() as connection:
                return assistant.save_settings(connection, changes)
        except assistant.SettingsError as error:
            return JSONResponse({"error": str(error)}, status_code=422)

    @router.get("/engines")
    async def list_engines():
        with database() as connection:
            current = assistant.load_settings(connection)
        found = await run_in_threadpool(lambda: [(e.name, e.available()) for e in engines(current, secrets)])
        active = next((name for name, ok in sorted(found, key=lambda f: f[0] != current["engine"]) if ok), None)
        return {"engines": [{"name": n, "available": ok} for n, ok in found], "active": active, "model": current["model"]}

    @router.put("/keys/{kind}")
    async def put_key(kind: Literal["anthropic", "compatible"], body: KeyIn):
        await run_in_threadpool(secrets.put, SECRET_ACCOUNTS[kind], body.key)
        return {"saved": body.key is not None}

    @router.get("/conversations")
    async def conversations(request: Request):
        owner = owner_of(request)
        if not owner:
            return JSONResponse({"error": "Falta el propietario."}, status_code=400)
        with database() as connection:
            rows = connection.execute(
                "SELECT id, title, persona, updated_at FROM conversation WHERE owner = ? ORDER BY updated_at DESC LIMIT 100", (owner,)
            ).fetchall()
        return {"conversations": [dict(row) for row in rows]}

    @router.post("/conversations", status_code=201)
    async def create(request: Request):
        owner = owner_of(request)
        if not owner:
            return JSONResponse({"error": "Falta el propietario."}, status_code=400)
        with database() as connection:
            persona = assistant.load_settings(connection)["persona"]
            stamp = now()
            row = connection.execute(
                "INSERT INTO conversation (owner, persona, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
                (owner, persona, stamp, stamp),
            ).fetchone()
        return {"id": row["id"], "persona": persona}

    @router.get("/conversations/{conversation_id}")
    async def read(conversation_id: int, request: Request):
        owner = owner_of(request)
        with database() as connection:
            conversation = owned(connection, conversation_id, owner or "")
            if not conversation:
                return JSONResponse({"error": "Conversación no encontrada."}, status_code=404)
            messages = connection.execute(
                "SELECT role, content, sources, engine, model, created_at FROM message WHERE conversation_id = ? ORDER BY id",
                (conversation_id,),
            ).fetchall()
        return {**dict(conversation), "messages": [{**dict(m), "sources": json.loads(m["sources"])} for m in messages]}

    @router.post("/conversations/{conversation_id}/messages")
    async def send(conversation_id: int, body: MessageIn, request: Request):
        owner = owner_of(request)
        with database() as connection:
            conversation = owned(connection, conversation_id, owner or "")
            if not conversation:
                return JSONResponse({"error": "Conversación no encontrada."}, status_code=404)
            current = assistant.load_settings(connection)
            history = [dict(row) for row in connection.execute(
                "SELECT role, content FROM (SELECT id, role, content FROM message WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
                (conversation_id, HISTORY),
            )]

        async def answer():
            try:
                yield _event("stage", {"stage": "recuerda"})

                def recall():
                    # Every engine runs outside this Mac: only what the external audience may see.
                    with database() as connection:
                        return search(connection, body.message, embedder, cache, "external", SOURCES, with_text=True)["results"]
                found = await run_in_threadpool(recall)
                sources = [{"n": n, "title": r["title"], "folder": r["folder"], "source": r["source"], "ref": r["ref"]}
                           for n, r in enumerate(found, start=1)]
                yield _event("sources", {"sources": sources})
                yield _event("stage", {"stage": "piensa"})
                engine = await run_in_threadpool(lambda: choose(engines(current, secrets), current["engine"]))
                model = current["compatible"]["model"] if engine.name == "compatible" else current["model"]
                question = f"{assistant.context_block(found)}\n\nPregunta: {body.message}"
                turn = Turn(assistant.system_prompt(current), [*history, {"role": "user", "content": question}], model)
                yield _event("stage", {"stage": "responde", "engine": engine.name, "model": model})
                parts = []
                async for text in engine.stream(turn):
                    parts.append(text)
                    yield _event("delta", {"text": text})
                reply = "".join(parts).strip()
                if not reply:
                    raise EngineError("El motor no devolvió texto.")

                def store():
                    with database() as connection:
                        stamp = now()
                        connection.execute("BEGIN IMMEDIATE")
                        connection.execute(
                            "INSERT INTO message (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
                            (conversation_id, body.message, stamp),
                        )
                        connection.execute(
                            "INSERT INTO message (conversation_id, role, content, sources, engine, model, created_at) VALUES (?, 'assistant', ?, ?, ?, ?, ?)",
                            (conversation_id, reply, json.dumps(sources, ensure_ascii=False), engine.name, model, stamp),
                        )
                        title = body.message[:60] if conversation["title"] == "Conversación nueva" else conversation["title"]
                        connection.execute("UPDATE conversation SET updated_at = ?, title = ? WHERE id = ?", (stamp, title, conversation_id))
                        connection.execute("COMMIT")
                await run_in_threadpool(store)
                yield _event("done", {"engine": engine.name, "model": model, "sources": len(sources)})
            except EngineError as error:
                yield _event("error", {"error": str(error)})
            except Exception:  # noqa: BLE001 - the stream must end with an error event, not a broken connection
                yield _event("error", {"error": "No se pudo completar la respuesta."})

        return StreamingResponse(answer(), media_type="text/event-stream")

    return router
