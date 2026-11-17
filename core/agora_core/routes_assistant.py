"""HTTP routes of the assistant: settings, engines, keys and conversations answered by Server-Sent Events."""

import json
import re
import sqlite3
import sys
import time
from pathlib import Path
from collections.abc import Callable
from contextlib import aclosing, contextmanager
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import assistant
from .brain_tools import Toolbox
from .db import DB_NAME, connect, now, transaction
from .embed import Embedder, VectorCache
from .engines import (
    SECRET_ACCOUNTS, AnthropicApiEngine, ClaudeCodeEngine, CompatibleEngine, Engine, EngineError, Turn, usable,
)
from .search import search
from .settings import Settings

_OWNER = re.compile(r"[a-f0-9]{64}")
HISTORY = 20
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


def _logged(event: dict) -> tuple[str, str]:
    """A tool call as (action, detail) for the action log."""
    if event["tool"] == "search":
        return "buscar", json.dumps({"query": event["query"], "found": len(event["found"])}, ensure_ascii=False)
    if event["tool"] == "clients":
        return "clientes", json.dumps({"filter": event["filter"], "count": event["count"]}, ensure_ascii=False)
    if event["tool"] == "inbox":
        return "bandeja", json.dumps({"filter": event["filter"], "count": event["count"]}, ensure_ascii=False)
    if event["tool"] == "reorg_proposal":  # how many changes, never titles or folders
        return "proponer_reorganizacion", json.dumps({"cambios": len(event["moves"]), "renombrados": sum(1 for m in event["moves"] if m["toTitle"])}, ensure_ascii=False)
    if event["tool"] == "vault_outline":
        return "revisar_vault", json.dumps({"notas": event["notes"], "carpetas": event["folders"]}, ensure_ascii=False)
    if event["tool"] == "cleanup_proposal":  # how many and what to do, never senders or subjects
        return "proponer_limpieza", json.dumps({"accion": event["action"], "correos": len(event["messages"])}, ensure_ascii=False)
    if event["tool"] == "quote_proposal":  # for whom and how many lines, not the prices
        return "proponer_presupuesto", json.dumps({"cliente": event["quote"].get("client"), "partidas": len(event["quote"].get("items") or [])}, ensure_ascii=False)
    if event["tool"] == "event_proposal":  # that an event was proposed and when, not its title or notes
        return "proponer_evento", json.dumps({"inicio": event["event"].get("start")}, ensure_ascii=False)
    if event["tool"] == "note_proposal":  # that a note was proposed and where, not what it says
        return "proponer_nota", json.dumps({"carpeta": event["note"].get("folder") or ""}, ensure_ascii=False)
    if event["tool"] == "rule_proposal":  # what kind of rule, not its sender or words
        return "proponer_regla", json.dumps({"action": event["rule"].get("action")}, ensure_ascii=False)
    if event["tool"] == "orca_proposal":  # which repository and agent, not the task
        return "proponer_encargo_orca", json.dumps({"repositorio": event["proposal"].get("repo"), "agente": event["proposal"].get("agent")}, ensure_ascii=False)
    if event["tool"] == "issue_proposal":  # which repository, not what it says
        return "proponer_issue", json.dumps({"repositorio": event["issue"].get("repo")}, ensure_ascii=False)
    if event["tool"] == "meetings":  # how many, not the words searched
        return "consultar_reuniones", json.dumps({"reuniones": event["count"]}, ensure_ascii=False)
    if event["tool"] == "meeting":
        return "leer_reunion", json.dumps({"parte": event.get("part")}, ensure_ascii=False)
    if event["tool"] in ("projects", "agenda", "day"):
        return event["tool"], json.dumps({k: v for k, v in event.items() if k != "tool"}, ensure_ascii=False, default=str)
    if event["tool"] == "read":
        return "leer", json.dumps({"n": event.get("n")}, ensure_ascii=False)
    return str(event.get("tool") or "herramienta"), "{}"


# Answers being written right now, for the «Agentes» section (only how many and since when).
ANSWERING: dict = {"now": 0, "since": None}


def _event(kind: str, data) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class CleanupChoice(BaseModel):
    ids: list[int]


def assistant_router(
    settings: Settings, embedder: Embedder | None, cache: VectorCache, secrets,
    engines: Callable[[dict, object], list[Engine]] = default_engines,
) -> APIRouter:
    router = APIRouter(prefix="/assistant")
    # Rules Watson proposed, waiting for the user's «Crear regla»: one-time ids, for one hour, for their owner.
    proposals: dict[str, dict] = {}

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

    @router.post("/proposals/{proposal_id}/accept", status_code=201)
    async def accept_proposal(proposal_id: str, request: Request):
        """Creates the very rule Watson proposed, once, for the owner it was proposed to."""
        from . import mail_rules
        owner = owner_of(request)
        found = proposals.get(proposal_id)
        if not owner or found is None or found["owner"] != owner or found["expires"] < time.time():
            return JSONResponse({"error": "Esa propuesta ya no está disponible: pídesela otra vez a Watson."}, status_code=404)
        if "rule" not in found:  # a note is created by the vault's own route, never here
            return JSONResponse({"error": "Esa propuesta no es una regla."}, status_code=409)
        proposals.pop(proposal_id, None)  # taken before any wait: a double click or a click and a «sí» create one rule
        def work(connection):
            rule_id = mail_rules.create_rule(connection, found["rule"])
            with transaction(connection):
                connection.execute("INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, 'usuario', 'crear_regla', 'done', ?)",
                                   (now(), json.dumps({"rule": rule_id, "from": "watson"}, ensure_ascii=False)))
            return rule_id
        try:
            rule_id = await db(work)
        except (mail_rules.RuleError, sqlite3.IntegrityError) as error:
            message = str(error) if isinstance(error, mail_rules.RuleError) else "La regla no se pudo guardar tal cual: pídesela otra vez a Watson."
            return JSONResponse({"error": message}, status_code=422)
        return {"id": rule_id, "name": found["rule"]["name"]}

    @router.post("/proposals/{proposal_id}/quote", status_code=201)
    async def create_quote(proposal_id: str, request: Request):
        """Creates in Central, as a draft, the very quote Watson proposed, once, for the owner it was proposed to."""
        from . import addons, central
        owner = owner_of(request)
        found = proposals.get(proposal_id)
        if not owner or found is None or found["owner"] != owner or found["expires"] < time.time() or "quote" not in found:
            return JSONResponse({"error": "Esa propuesta ya no está disponible: pídesela otra vez a Watson."}, status_code=404)
        proposals.pop(proposal_id, None)  # taken before any wait: a double click creates one quote
        def work():
            with database() as connection:
                path = addons.config(connection, "central").get("path")
            if not path or not addons.recognised("central", Path(path)):
                raise central.CentralError("Central no está configurado en Conectores.")
            return central.create_quote(Path(path), found["quote"])
        try:
            made = await run_in_threadpool(work)
        except (central.CentralError, Exception) as error:  # noqa: BLE001 - Central's own message, or that it failed
            return JSONResponse({"error": str(error) if isinstance(error, central.CentralError) else "Central no pudo crear el presupuesto."}, status_code=422)
        return {"created": made}

    @router.post("/proposals/{proposal_id}/issue", status_code=201)
    async def create_issue(proposal_id: str, request: Request):
        """Creates on GitHub, with the user's own `gh`, the very issue Watson proposed, once, for its owner."""
        from . import github_issues
        owner = owner_of(request)
        found = proposals.get(proposal_id)
        if not owner or found is None or found["owner"] != owner or found["expires"] < time.time() or "issue" not in found:
            return JSONResponse({"error": "Esa propuesta ya no está disponible: pídesela otra vez a Watson."}, status_code=404)
        proposals.pop(proposal_id, None)  # taken before any wait: a double click creates one issue
        try:
            url = await run_in_threadpool(github_issues.create, found["issue"])
        except github_issues.IssueError as error:
            return JSONResponse({"error": str(error)}, status_code=422)
        return {"url": url, "repo": found["issue"]["repo"]}

    @router.post("/proposals/{proposal_id}/mail")
    async def clean_mail(proposal_id: str, request: Request, body: CleanupChoice):
        """Moves to the archive or the trash the messages the user approved, only from the list Watson proposed."""
        from . import mail, mail_cleanup
        from .routes_mail import microsoft_login
        owner = owner_of(request)
        found = proposals.get(proposal_id)
        if not owner or found is None or found["owner"] != owner or found["expires"] < time.time() or "cleanup" not in found:
            return JSONResponse({"error": "Esa propuesta ya no está disponible: pídesela otra vez a Watson."}, status_code=404)
        chosen = [i for i in body.ids if i in set(found["cleanup"]["ids"])]
        if not chosen:
            return JSONResponse({"error": "No has elegido ningún correo de la lista."}, status_code=422)
        proposals.pop(proposal_id, None)  # once: a double click moves nothing twice
        def work():
            with database() as connection:
                return mail_cleanup.move(connection, chosen, found["cleanup"]["action"], lambda account: secrets.get(mail.secret_account(account)),
                                         login=microsoft_login(connection, secrets))
        try:
            return await run_in_threadpool(work)
        except mail_cleanup.CleanupError as error:
            return JSONResponse({"error": str(error)}, status_code=422)

    @router.post("/proposals/{proposal_id}/dismiss")
    async def dismiss_proposal(proposal_id: str, request: Request):
        owner = owner_of(request)
        if owner and proposals.get(proposal_id, {}).get("owner") == owner:
            proposals.pop(proposal_id, None)
        return {"ok": True}

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

        def store(reply: str | None, sources: list, engine: str | None, model: str | None, done: list | None = None):
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
                # What Watson searched and read, in the action log (the summary ranks its searches).
                connection.executemany(
                    "INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, 'watson', ?, 'done', ?)",
                    [(stamp, *_logged(e)) for e in done or []],
                )
                title = body.message[:60] if conversation["title"] == "Conversación nueva" else conversation["title"]
                connection.execute("UPDATE conversation SET updated_at = ?, title = ? WHERE id = ?", (stamp, title, conversation_id))
                connection.execute("COMMIT")
            return db(write)

        async def answer():
            replied = False
            ANSWERING["now"] += 1
            ANSWERING["since"] = ANSWERING["since"] or now()
            try:
                yield _event("stage", {"stage": "recuerda"})
                # Every engine runs outside this Mac: only what the external audience may see.
                found = await db(lambda c: search(c, body.message, embedder, cache, "external", SOURCES, with_text=True)["results"])
                context, included = assistant.context_block(found)
                # The first notes come with the question; the tools number the next ones after them.
                toolbox = Toolbox(database, embedder, cache)
                toolbox.proposals, toolbox.owner = proposals, owner
                toolbox.register(found[:included])
                yield _event("sources", {"sources": toolbox.sources})
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
                    turn = Turn(system, [*history, {"role": "user", "content": question}], model, toolbox)
                    parts = []
                    try:
                        # aclosing: if the browser leaves, the engine (and Claude Code's process) is closed too.
                        async with aclosing(engine.stream(turn)) as stream:
                            async for text in stream:
                                # What the tools did, as soon as it is known: an engine may announce a tool round
                                # before the tool runs (Claude Code does), so it is collected again here.
                                done_now = toolbox.drain()
                                for done in done_now:
                                    yield _event("tool", done)
                                if text is None or done_now:
                                    yield _event("sources", {"sources": toolbox.sources})
                                if text is None:
                                    continue
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
                    # The last tool of the answer (often a proposal for the screen) may have run after the last round.
                    late = toolbox.drain()
                    for done in late:
                        yield _event("tool", done)
                    if late:
                        yield _event("sources", {"sources": toolbox.sources})
                    reply = "".join(parts).strip()
                    if not reply:
                        last_error = EngineError("El motor no devolvió texto.")
                        continue
                    sources = assistant.cited(reply, toolbox.sources)
                    await store(reply, sources, engine.name, model, toolbox.history)
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
                ANSWERING["now"] = max(0, ANSWERING["now"] - 1)
                if not ANSWERING["now"]:
                    ANSWERING["since"] = None
                if not replied:
                    try:
                        await store(None, [], None, None)
                    except Exception as error:  # noqa: BLE001
                        print(f"AgoraOne núcleo: no se pudo guardar la pregunta ({error}).", file=sys.stderr)

        return StreamingResponse(answer(), media_type="text/event-stream")

    return router
