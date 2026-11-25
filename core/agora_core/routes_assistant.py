"""HTTP routes of the assistant: settings, engines, keys and conversations answered by Server-Sent Events."""

import asyncio
import json
import re
import sqlite3
import sys
import time
from collections import Counter
from collections.abc import Callable
from contextlib import aclosing, contextmanager
from typing import Literal

from fastapi import APIRouter, Path, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from . import assistant, hermes_tasks, research, web_page
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


class DelegatedIn(BaseModel):
    profile: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    reply: str = Field(min_length=1, max_length=hermes_tasks.REPLY_LIMIT)  # cut to REPLY_CHARS, never refused for length


class ResearchIn(BaseModel):
    question: str = Field(min_length=1, max_length=research.QUESTION_CHARS)
    scope: str = Field(default="", max_length=research.QUESTION_CHARS)


class MessageIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    delegated: DelegatedIn | None = None  # a Hermes profile's answer the user passes on: data, never instructions
    research: ResearchIn | None = None  # the user pressed «Investigar»: a web research turn, apart from this conversation
    botReply: str | None = Field(default=None, pattern=r"^msg_[A-Za-z0-9_-]{4,72}$")  # a bot's answer the user passes on, read from AgoraOne


class ConversationDeletion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: StrictBool
    created_at: str = Field(min_length=1, max_length=40)


class KeyIn(BaseModel):
    key: str | None = Field(default=None, min_length=8, max_length=500)


class SettingsIn(BaseModel):
    persona: str | None = None
    model: str | None = None
    engine: str | None = None
    tone: dict[str, str] | None = None
    compatible: dict[str, str | None] | None = None
    research: dict[str, StrictInt] | None = None


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
        return "proponer_encargo_orca", json.dumps({"repositorio": event["proposal"].get("repo"), "agente": event["proposal"].get("agent"),
                                                    **({"bot": event["proposal"]["botName"]} if event["proposal"].get("botName") else {})}, ensure_ascii=False)
    if event["tool"] == "crmdev_read":  # which list and how many, never what it says
        return "consultar_crmdev", json.dumps({"que": event["what"], "cuantos": event["count"]}, ensure_ascii=False)
    if event["tool"] == "crmdev_proposal":  # which kind and which fields, never their values
        request = event["proposal"]["request"]
        return "proponer_cambio_crmdev", json.dumps({"tipo": event["proposal"]["kind"], "campos": sorted(request.get("values") or request.get("changes") or {})},
                                                    ensure_ascii=False)
    if event["tool"] == "research_proposal":  # that one was proposed, never the question
        return "proponer_investigacion", "{}"
    if event["tool"] == "research":  # the caps it ran with, never the question
        return "investigar", json.dumps({k: event[k] for k in ("busquedas", "paginas", "minutos")}, ensure_ascii=False)
    if event["tool"] == "hermes_reply":  # that a profile's answer reached Watson, and how long; never its text
        return "respuesta_hermes", json.dumps({"perfil": event["profile"], "caracteres": event["chars"]}, ensure_ascii=False)
    if event["tool"] == "bot_reply":  # that a bot's answer reached Watson, and how long; never its text
        return "respuesta_bot", json.dumps({"bot": event["bot"], "caracteres": event["chars"]}, ensure_ascii=False)
    if event["tool"] == "hermes_proposal":  # which profile, not the task
        return "proponer_encargo_hermes", json.dumps({"perfil": event["proposal"].get("profile")}, ensure_ascii=False)
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
    if event["tool"] == "web":  # which sites and whether they were read, never the full address or the text
        return "leer_web", json.dumps({"sitios": [p["host"] for p in event["pages"]], "leidas": sum(1 for p in event["pages"] if p["ok"])}, ensure_ascii=False)
    return str(event.get("tool") or "herramienta"), "{}"


# Answers being written right now, for the «Agentes» section (only how many and since when).
ANSWERING: dict = {"now": 0, "since": None}


class AssistantStream(StreamingResponse):
    """Release the turn even if the request ends before the first streamed event."""

    def __init__(self, events, release: Callable[[], None]):
        super().__init__(events, media_type="text/event-stream")
        self.release = release

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                await self.body_iterator.aclose()
            finally:
                self.release()


async def _until(stream, deadline: float | None):
    """The engine's stream, with a time limit on each wait for it (not on what the caller does in between)."""
    while True:
        try:
            async with asyncio.timeout_at(deadline):
                item = await anext(stream)
        except StopAsyncIteration:
            return
        yield item


def _event(kind: str, data) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class CleanupChoice(BaseModel):
    ids: list[int]


def assistant_router(
    settings: Settings, embedder: Embedder | None, cache: VectorCache, secrets,
    engines: Callable[[dict, object], list[Engine]] = default_engines,
) -> APIRouter:
    router = APIRouter(prefix="/assistant")
    # Proposals awaiting confirmation: one-time ids, for one hour, for their owner and conversation.
    proposals: dict[str, dict] = {}
    active_turns: Counter[tuple[str, int]] = Counter()
    deleting: set[tuple[str, int]] = set()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def bot_reply(message_id: str):
        """A bot's answer kept by AgoraOne, as a block of data for Watson (None if there is none)."""
        from . import orca_bots

        with database() as connection:
            return orca_bots.reply_block(connection, message_id)

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

    def pending_proposal(proposal_id: str, owner: str | None):
        found = proposals.get(proposal_id)
        if (found is None or found["owner"] != owner or found["expires"] < time.time()
                or (owner, found["conversation_id"]) in deleting):
            return None
        return found

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
            "SELECT id, title, persona, created_at, updated_at FROM conversation WHERE owner = ? ORDER BY updated_at DESC LIMIT 100", (owner,)
        ).fetchall())
        return {"conversations": [dict(row) for row in rows]}

    @router.post("/proposals/{proposal_id}/accept", status_code=201)
    async def accept_proposal(proposal_id: str, request: Request):
        """Creates the very rule Watson proposed, once, for the owner it was proposed to."""
        from . import mail_rules
        owner = owner_of(request)
        found = pending_proposal(proposal_id, owner)
        if found is None:
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
        """Creates in Central, as a draft, the very quote Watson proposed, once, for the owner it was proposed to.
        Needs the «Presupuestos» module on (404 otherwise) and a connection whose key has the `presupuestos`
        permission; the «Central» module may be off."""
        from . import central, modules
        owner = owner_of(request)
        found = pending_proposal(proposal_id, owner)
        if found is None or "quote" not in found:
            return JSONResponse({"error": "Esa propuesta ya no está disponible: pídesela otra vez a Watson."}, status_code=404)
        def quotes_on():
            with database() as connection:
                return modules.state(connection)["presupuestos"]
        if not await run_in_threadpool(quotes_on):
            return JSONResponse({"error": "El módulo Presupuestos está apagado."}, status_code=404)
        def connected():
            with database() as connection:
                return central.source(connection, secrets)
        origin = await run_in_threadpool(connected)
        if origin is None:
            return JSONResponse({"error": "Central no está conectado: conéctalo con su dirección y su clave."}, status_code=422)
        if pending_proposal(proposal_id, owner) is not found:
            return JSONResponse({"error": "Esa propuesta ya no está disponible: pídesela otra vez a Watson."}, status_code=404)
        proposals.pop(proposal_id)  # once, after the checks and before the external write
        def work():
            return central.create_quote(origin, found["quote"])
        try:
            made = await run_in_threadpool(work)
        except (central.CentralError, Exception) as error:  # noqa: BLE001 - Central's own message, or that it failed
            return JSONResponse({"error": str(error) if isinstance(error, central.CentralError) else "Central no pudo crear el presupuesto."}, status_code=422)
        return {"created": made}

    @router.post("/proposals/{proposal_id}/chat-reply")
    async def open_chat_reply(proposal_id: str, request: Request):
        """Hands the screen the WhatsApp reply Watson proposed, once, for its owner, to open the reply composer with it.
        Sends nothing: a WhatsApp only leaves from `/chat/send`, with the seal of the preview the user saw."""
        from . import brain_chat, chat_inbox
        owner = owner_of(request)
        found = pending_proposal(proposal_id, owner)
        if found is None or "chatReply" not in found:
            return JSONResponse({"error": "Esa propuesta ya no está disponible: pídesela otra vez a Watson."}, status_code=404)
        proposals.pop(proposal_id, None)  # taken before any wait: a double click opens it once
        reply = found["chatReply"]

        def check():
            with database() as connection:
                brain_chat.still_normal(connection, reply["conversationId"])
        try:
            await run_in_threadpool(check)
        except chat_inbox.ChatGone as error:
            return JSONResponse({"error": str(error)}, status_code=404)
        except brain_chat.ChatProposalError as error:
            return JSONResponse({"error": str(error)}, status_code=409)
        return {"conversationId": reply["conversationId"], "text": reply["text"]}

    @router.post("/proposals/{proposal_id}/issue", status_code=201)
    async def create_issue(proposal_id: str, request: Request):
        """Creates on GitHub, with the user's own `gh`, the very issue Watson proposed, once, for its owner."""
        from . import github_issues
        owner = owner_of(request)
        found = pending_proposal(proposal_id, owner)
        if found is None or "issue" not in found:
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
        found = pending_proposal(proposal_id, owner)
        if found is None or "cleanup" not in found:
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

    @router.delete("/conversations/{conversation_id}")
    async def delete_conversation(body: ConversationDeletion, request: Request, conversation_id: int = Path(gt=0, le=2**63 - 1)):
        owner = owner_of(request)
        if owner is None:
            return JSONResponse({"error": "Conversación no encontrada."}, status_code=404)
        if not body.confirm:
            return JSONResponse({"error": "Confirma que quieres eliminar la conversación."}, status_code=422)
        key = (owner, conversation_id)
        if key in active_turns or key in deleting:
            return JSONResponse({"error": "La conversación está ocupada. Espera a que termine y vuelve a intentarlo."}, status_code=409)

        def remove(connection):
            with transaction(connection):
                deleted = connection.execute(
                    "DELETE FROM conversation WHERE id = ? AND owner = ? AND created_at = ?",
                    (conversation_id, owner, body.created_at),
                ).rowcount
                if deleted:
                    return 200
                return 409 if owned(connection, conversation_id, owner) else 404

        deleting.add(key)
        try:
            status = await db(remove)
            if status == 404:
                return JSONResponse({"error": "Conversación no encontrada."}, status_code=404)
            if status == 409:
                return JSONResponse({"error": "La conversación cambió: vuelve a abrir la lista.", "code": "stale_conversation"}, status_code=409)
            for proposal_id, proposal in list(proposals.items()):
                if (proposal["owner"], proposal["conversation_id"]) == key:
                    proposals.pop(proposal_id)
            return {"deleted": True}
        finally:
            deleting.remove(key)

    @router.post("/conversations/{conversation_id}/messages")
    async def send(conversation_id: int, body: MessageIn, request: Request):
        owner = owner_of(request)
        if owner is None:
            return JSONResponse({"error": "Conversación no encontrada."}, status_code=404)
        key = (owner, conversation_id)
        if key in deleting:
            return JSONResponse({"error": "Se está eliminando la conversación."}, status_code=409)
        if body.research:  # what is kept and searched is the question itself, whatever the screen sent
            body.message, body.delegated = f"{research.ASKED}{body.research.question}", None

        def prepare(connection):
            conversation = owned(connection, conversation_id, owner)
            if not conversation:
                return None
            history = [dict(row) for row in connection.execute(
                """SELECT role, content FROM (SELECT id, role, content FROM message
                   WHERE conversation_id = ? AND failed = 0 ORDER BY id DESC LIMIT ?) ORDER BY id""",
                (conversation_id, HISTORY),
            )]
            return dict(conversation), assistant.load_settings(connection), research.as_data(history)
        def release():
            active_turns[key] -= 1
            if not active_turns[key]:
                del active_turns[key]

        active_turns[key] += 1
        try:
            prepared = await db(prepare)
        except BaseException:
            release()
            raise
        if prepared is None:
            release()
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
                toolbox.proposals, toolbox.owner, toolbox.secrets = proposals, owner, secrets
                toolbox.conversation_id = conversation_id
                caps = research.limits(current) if body.research else None
                if caps:  # only the web, normal notes and proponer_nota: never mail, chats, clients or the history
                    toolbox.only, toolbox.pages_left, toolbox.max_calls = research.TOOLS, caps["pages"], caps["pages"] + 6
                    toolbox.history.append({"tool": "research", "busquedas": caps["searches"], "paginas": caps["pages"], "minutos": caps["minutes"]})
                toolbox.register(found[:included])
                yield _event("sources", {"sources": toolbox.sources})
                # Only the addresses the user wrote in this message; the core reads them, Watson has no network.
                pages_block = ""
                urls = [] if body.research else web_page.urls_in(body.message)  # a research reads its pages itself
                if body.research:
                    research.remember(toolbox, f"{body.research.question} {body.research.scope}")
                if urls:
                    yield _event("stage", {"stage": "web"})
                    pages = await web_page.fetch_all(urls)
                    pages_block = web_page.block(pages)
                    read_event = {"tool": "web", "pages": [{"host": p.host, "ok": not p.error} for p in pages]}
                    toolbox.history.append(read_event)
                    yield _event("tool", read_event)
                yield _event("stage", {"stage": "piensa"})
                candidates = await run_in_threadpool(lambda: usable(build_engines(current), current["engine"]))
                if not candidates:
                    raise EngineError(
                        "No hay ningún motor disponible: inicia sesión en Claude Code, añade una clave de API de "
                        "Anthropic o configura un proveedor compatible en Ajustes."
                    )
                system = assistant.system_prompt(current)
                if body.delegated:
                    pages_block = "\n\n".join(filter(None, [hermes_tasks.reply_block(body.delegated.profile, body.delegated.reply), pages_block]))
                    toolbox.history.append({"tool": "hermes_reply", "profile": body.delegated.profile, "chars": len(body.delegated.reply)})
                if body.botReply:
                    found = await run_in_threadpool(bot_reply, body.botReply)
                    if found:
                        pages_block = "\n\n".join(filter(None, [found[1], pages_block]))
                        toolbox.history.append({"tool": "bot_reply", "bot": found[0], "chars": len(found[1])})
                question = f"{context}\n\n{pages_block + chr(10) + chr(10) if pages_block else ''}Pregunta: {body.message}"
                if body.research:
                    question = f"{context}\n\n{body.message}"
                    candidates = candidates[:1]  # never again on another engine, with the budget spent and the clock reset
                deadline = asyncio.get_running_loop().time() + caps["minutes"] * 60 if caps else None
                last_error = None
                for engine in candidates:
                    model = current["compatible"]["model"] if engine.name == "compatible" else current["model"]
                    if caps:
                        searches = 0 if engine.name == "compatible" else caps["searches"]
                        turn = Turn(research.system_prompt(system, body.research.scope, caps["searches"], bool(searches)),
                                    [{"role": "user", "content": question}], model, toolbox, research.TOOLS, searches)
                    else:
                        turn = Turn(system, [*history, {"role": "user", "content": question}], model, toolbox)
                    parts = []
                    try:
                        # aclosing: if the browser leaves, the engine (and Claude Code's process) is closed too.
                        async with aclosing(engine.stream(turn)) as stream:
                            # The research's time counts only while the engine works, never while the browser reads.
                            async for text in _until(stream, deadline):
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
                    except TimeoutError as error:
                        raise EngineError(f"La investigación ha superado los {caps['minutes']} minutos de Ajustes: no se ha guardado.") from error
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

        return AssistantStream(answer(), release)

    return router
