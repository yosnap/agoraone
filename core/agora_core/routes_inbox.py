"""HTTP routes of the mail rules and the Bandeja: the cards waiting for the user, their decisions and what
the assistant announces. Deciding a card only records the user's choice; no route runs an action that a
message asks for."""

import sqlite3
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool, StrictInt

from . import mail_inbox, mail_rules
from .db import DB_NAME, connect
from .settings import Settings

Action = Literal["invoice", "client", "personal", "important", "ignore"]
Level = Literal["normal", "local_only", "private"]


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    sender: str | None = Field(default=None, max_length=254)
    accountId: StrictInt | None = None
    subject: str | None = Field(default=None, max_length=200)
    words: str | None = Field(default=None, max_length=200)
    action: Action
    scopeId: StrictInt | None = None
    confidentiality: Level | None = None
    enabled: StrictBool = True


class RuleChange(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    sender: str | None = Field(default=None, max_length=254)
    accountId: StrictInt | None = None
    subject: str | None = Field(default=None, max_length=200)
    words: str | None = Field(default=None, max_length=200)
    action: Action | None = None
    scopeId: StrictInt | None = None
    confidentiality: Level | None = None
    enabled: StrictBool | None = None


class DecisionIn(BaseModel):
    state: Literal["pending", "done", "dismissed"]


class MoveIn(BaseModel):
    ids: list[StrictInt] = Field(min_length=1, max_length=200)
    action: Literal["trash", "archive"]


def inbox_router(settings: Settings, health, secrets=None) -> APIRouter:
    router = APIRouter()

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

    async def rules():
        return {"rules": await db(mail_rules.list_rules)}

    @router.get("/mail/rules")
    async def get_rules():
        return await rules()

    @router.post("/mail/rules", status_code=201)
    async def create_rule(body: RuleIn):
        try:
            await db(lambda c: mail_rules.create_rule(c, body.model_dump()))
        except (mail_rules.RuleError, sqlite3.IntegrityError) as error:
            return JSONResponse({"error": str(error) if isinstance(error, mail_rules.RuleError) else "Regla no válida."}, status_code=422)
        return await rules()

    @router.put("/mail/rules/{rule_id}")
    async def change_rule(rule_id: int, body: RuleChange):
        try:
            found = await db(lambda c: mail_rules.update_rule(c, rule_id, body.model_dump(exclude_unset=True)))
        except (mail_rules.RuleError, sqlite3.IntegrityError) as error:
            return JSONResponse({"error": str(error) if isinstance(error, mail_rules.RuleError) else "Regla no válida."}, status_code=422)
        if not found:
            return JSONResponse({"error": "Esa regla no existe."}, status_code=404)
        return await rules()

    @router.delete("/mail/rules/{rule_id}")
    async def delete_rule(rule_id: int):
        if not await db(lambda c: mail_rules.delete_rule(c, rule_id)):
            return JSONResponse({"error": "Esa regla no existe."}, status_code=404)
        return await rules()

    @router.get("/mail/inbox")
    async def inbox(state: Literal["pending", "done", "dismissed"] = "pending", limit: int = 100):
        limit = max(1, min(limit, 300))
        items, counted = await db(lambda c: (mail_inbox.inbox(c, state, limit), mail_inbox.counts(c)))
        return {"items": items, "counts": counted, "problem": health.problem}

    @router.post("/mail/inbox/archive-all")
    async def archive_all():
        archived = await db(mail_inbox.archive_all)
        return {"archived": archived, "counts": await db(mail_inbox.counts)}

    @router.get("/mail/inbox/advertising")
    async def advertising():
        """The advertising still in the accounts' inboxes (it never gets a card): the list the user reviews before
        «Eliminar publicidad»."""
        from . import mail_cleanup

        def work(connection):
            found = mail_cleanup.candidates(connection, kind="publicidad")
            mailboxes = {r["id"] for r in connection.execute(
                "SELECT m.id FROM mail_message m JOIN mail_account a ON a.id = m.account_id WHERE a.kind = 'mailbox' AND m.folder = 'INBOX'")}
            return [m for m in found if m["id"] in mailboxes]
        return {"messages": await db(work)}

    @router.post("/mail/inbox/move")
    async def move(body: MoveIn):
        """Moves the cards' messages the user confirmed in the Bandeja to their account's trash or archive (never
        deleted for good). Only messages that have a card; mail read through Resend's API cannot be moved."""
        from . import mail, mail_cleanup
        from .routes_mail import microsoft_login

        def work(connection):
            ids = list(dict.fromkeys(body.ids))
            marks = ",".join("?" * len(ids))
            movable = [r["id"] for r in connection.execute(
                f"""SELECT m.id FROM mail_message m JOIN mail_summary s ON s.message_id = m.id JOIN mail_account a ON a.id = m.account_id
                    WHERE m.id IN ({marks}) AND m.folder = 'INBOX' AND m.moved IS NULL AND a.kind = 'mailbox'""", ids)]
            done = mail_cleanup.move(connection, movable, body.action, lambda account: secrets.get(mail.secret_account(account)),
                                     login=microsoft_login(connection, secrets)) if movable else {"moved": 0, "problems": []}
            skipped = len(ids) - len(movable)
            if skipped:
                done["problems"].append(f"{skipped} {'correo no se puede mover' if skipped == 1 else 'correos no se pueden mover'} desde AgoraOne "
                                        "(ya estaban movidos, o se leyeron con la API de Resend, que no deja borrar)")
            return done
        if secrets is None:
            return JSONResponse({"error": "El correo no está disponible."}, status_code=503)
        try:
            return {**await db(work), "counts": await db(mail_inbox.counts)}
        except mail_cleanup.CleanupError as error:
            return JSONResponse({"error": str(error)}, status_code=422)

    @router.put("/mail/inbox/{message_id}")
    async def decide(message_id: int, body: DecisionIn):
        if not await db(lambda c: mail_inbox.decide(c, message_id, body.state)):
            return JSONResponse({"error": "Esa tarjeta no existe."}, status_code=404)
        return {"ok": True}

    @router.post("/mail/inbox/announce")
    async def announce():
        """What the assistant announces now; each card is handed out once."""
        return {"items": await db(mail_inbox.claim_announcements)}

    return router
