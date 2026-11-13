"""HTTP routes of the assistant: settings, engines, keys and conversations answered by Server-Sent Events."""

import json
import re
import sqlite3
import sys
from collections.abc import Callable
from contextlib import aclosing, contextmanager
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import assistant
from .db import DB_NAME, connect, now
from .embed import Embedder, VectorCache
from .engines import (
    SECRET_ACCOUNTS, AnthropicApiEngine, ClaudeCodeEngine, CompatibleEngine, Engine, EngineError, Turn, usable,
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


def default_engines(settings: dict, secrets, workdir=None) -> list[Engine]:
    compatible = settings["compatible"]
    return [ClaudeCodeEngine(workdir), AnthropicApiEngine(secrets), CompatibleEngine(secrets, compatible["baseUrl"], compatible["model"])]


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

    def db(work):
        """SQLite work runs in a worker thread, never on the event loop (a busy database waits there)."""
        def task():
            with database() as connection:
                return work(connection)
        return run_in_threadpool(task)

    def build_engines(current: dict) -> list[Engine]:
        try:
            return engines(current, secrets, settings.data_dir / "claude-code")
        except TypeError:  # test doubles take two arguments
            return engines(current, secrets)

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
        return await db(assistant.load_settings)

    @router.put("/settings")
    async def put_settings(body: SettingsIn):
        changes = body.model_dump(exclude_unset=True)
        try:
            saved, moved = await db(lambda c: assistant.save_settings(c, changes))
        except assistant.SettingsError as error:
            return JSONResponse({"error": str(error)}, status_code=422)
        if moved:  # a key is only ever sent to the address it was given for
            await run_in_threadpool(secrets.put, SECRET_ACCOUNTS["compatible"], None)
        return saved

    @router.get("/engines")
    async def list_engines():
        current = await db(assistant.load_settings)
        listed = await run_in_threadpool(build_engines, current)
        found = await run_in_threadpool(lambda: [(e.name, e.available()) for e in listed])
        ready = await run_in_threadpool(usable, listed, current["engine"])
        return {"engines": [{"name": n, "available": ok} for n, ok in found],
                "active": ready[0].name if ready else None, "model": current["model"]}

    @router.put("/keys/{kind}")
    async def put_key(kind: Literal["anthropic", "compatible"], body: KeyIn):
        await run_in_threadpool(secrets.put, SECRET_ACCOUNTS[kind], body.key)
        return {"saved": body.key is not None}

    @router.get("/conversations")
    async def conversations(request: Request):
        owner = owner_of(request)
        if not owner:
            return JSONResponse({"error": "Falta el propietario."}, status_code=400)
        rows = await db(lambda c: c.execute(
            "SELECT id, title, persona, updated_at FROM conversation WHERE owner = ? ORDER BY updated_at DESC LIMIT 100", (owner,)
        ).fetchall())
        return {"conversations": [dict(row) for row in rows]}

    @router.post("/conversations", status_code=201)
    async def create(request: Request):
        owner = owner_of(request)
        if not owner:
            return JSONResponse({"error": "Falta el propietario."}, status_code=400)
        def create_one(connection):
            persona = assistant.load_settings(connection)["persona"]
            stamp = now()
            row = connection.execute(
                "INSERT INTO conversation (owner, persona, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
                (owner, persona, stamp, stamp),
            ).fetchone()
            return {"id": row["id"], "persona": persona}
        return await db(create_one)

    @router.get("/conversations/{conversation_id}")
    async def read(conversation_id: int, request: Request):
        owner = owner_of(request)

        def load(connection):
            conversation = owned(connection, conversation_id, owner or "")
            if not conversation:
                return None
            messages = connection.execute(
                "SELECT role, content, sources, engine, model, failed, created_at FROM message WHERE conversation_id = ? ORDER BY id",
                (conversation_id,),
            ).fetchall()
            return {**dict(conversation), "messages": [{**dict(m), "failed": bool(m["failed"]), "sources": json.loads(m["sources"])} for m in messages]}
        found = await db(load)
        return found or JSONResponse({"error": "Conversación no encontrada."}, status_code=404)

    @router.post("/conversations/{conversation_id}/messages")
    async def send(conversation_id: int, body: MessageIn, request: Request):
        owner = owner_of(request)

        def prepare(connection):
            conversation = owned(connection, conversation_id, owner or "")
            if not conversation:
                return None
            history = [dict(row) for row in connection.execute(
                """SELECT role, content FROM (SELECT id, role, content FROM message
                   WHERE conversation_id = ? AND failed = 0 ORDER BY id DESC LIMIT ?) ORDER BY id""",
                (conversation_id, HISTORY),
            )]
            return dict(conversation), assistant.load_settings(connection), history
        prepared = await db(prepare)
        if prepared is None:
            return JSONResponse({"error": "Conversación no encontrada."}, status_code=404)
        conversation, current, history = prepared

        def store(reply: str | None, sources: list, engine: str | None, model: str | None):
            """The question is always kept; without a reply it is marked as unanswered."""
            def write(connection):
                stamp = now()
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "INSERT INTO message (conversation_id, role, content, failed, created_at) VALUES (?, 'user', ?, ?, ?)",
                    (conversation_id, body.message, int(reply is None), stamp),
                )
                if reply is not None:
                    connection.execute(
                        "INSERT INTO message (conversation_id, role, content, sources, engine, model, created_at) VALUES (?, 'assistant', ?, ?, ?, ?, ?)",
                        (conversation_id, reply, json.dumps(sources, ensure_ascii=False), engine, model, stamp),
                    )
                title = body.message[:60] if conversation["title"] == "Conversación nueva" else conversation["title"]
                connection.execute("UPDATE conversation SET updated_at = ?, title = ? WHERE id = ?", (stamp, title, conversation_id))
                connection.execute("COMMIT")
            return db(write)

        async def answer():
            replied = False
            try:
                yield _event("stage", {"stage": "recuerda"})
                # Every engine runs outside this Mac: only what the external audience may see.
                found = await db(lambda c: search(c, body.message, embedder, cache, "external", SOURCES, with_text=True)["results"])
                context, included = assistant.context_block(found)
                sources = [{"n": n, "title": r["title"], "folder": r["folder"], "source": r["source"], "ref": r["ref"]}
                           for n, r in enumerate(found[:included], start=1)]
                yield _event("sources", {"sources": sources})
                yield _event("stage", {"stage": "piensa"})
                candidates = await run_in_threadpool(lambda: usable(build_engines(current), current["engine"]))
                if not candidates:
                    raise EngineError(
                        "No hay ningún motor disponible: inicia sesión en Claude Code, añade una clave de API de "
                        "Anthropic o configura un proveedor compatible en Ajustes."
                    )
                system = assistant.system_prompt(current)
                question = f"{context}\n\nPregunta: {body.message}"
                last_error = None
                for engine in candidates:
                    model = current["compatible"]["model"] if engine.name == "compatible" else current["model"]
                    turn = Turn(system, [*history, {"role": "user", "content": question}], model)
                    parts = []
                    try:
                        # aclosing: if the browser leaves, the engine (and Claude Code's process) is closed too.
                        async with aclosing(engine.stream(turn)) as stream:
                            async for text in stream:
                                if not parts:
                                    yield _event("stage", {"stage": "responde", "engine": engine.name, "model": model})
                                parts.append(text)
                                yield _event("delta", {"text": text})
                    except EngineError as error:
                        if parts:  # already half-answered: no silent switch to another engine
                            raise
                        last_error = error
                        print(f"AgoraOne núcleo: el motor {engine.name} falló, se prueba el siguiente ({error}).", file=sys.stderr)
                        continue
                    reply = "".join(parts).strip()
                    if not reply:
                        last_error = EngineError("El motor no devolvió texto.")
                        continue
                    await store(reply, sources, engine.name, model)
                    replied = True
                    yield _event("done", {"engine": engine.name, "model": model, "sources": len(sources)})
                    return
                raise last_error or EngineError("Ningún motor pudo responder.")
            except EngineError as error:
                yield _event("error", {"error": str(error)})
            except Exception as error:  # noqa: BLE001 - the stream must end with an error event, not a broken connection
                print(f"AgoraOne núcleo: fallo al responder ({type(error).__name__}: {error}).", file=sys.stderr)
                yield _event("error", {"error": "No se pudo completar la respuesta."})
            finally:
                if not replied:
                    try:
                        await store(None, [], None, None)
                    except Exception as error:  # noqa: BLE001
                        print(f"AgoraOne núcleo: no se pudo guardar la pregunta ({error}).", file=sys.stderr)

        return StreamingResponse(answer(), media_type="text/event-stream")

    return router
