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


class AnnouncedIn(BaseModel):
    ids: list[StrictInt] = Field(max_length=50)


def inbox_router(settings: Settings, health) -> APIRouter:
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

    @router.put("/mail/inbox/{message_id}")
    async def decide(message_id: int, body: DecisionIn):
        if not await db(lambda c: mail_inbox.decide(c, message_id, body.state)):
            return JSONResponse({"error": "Esa tarjeta no existe."}, status_code=404)
        return {"ok": True}

    @router.get("/mail/inbox/announce")
    async def announce():
        return {"items": await db(mail_inbox.to_announce)}

    @router.post("/mail/inbox/announced")
    async def announced(body: AnnouncedIn):
        await db(lambda c: mail_inbox.mark_announced(c, body.ids))
        return {"ok": True}

    return router
