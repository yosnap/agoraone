"""HTTP routes of mail accounts and scopes, and the background reading of new mail every few minutes."""

import re
import sqlite3
import sys
import threading
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool, StrictInt

from . import mail
from .db import DB_NAME, connect, now
from .settings import Settings

SYNC_SECONDS = 300
Level = Literal["normal", "local_only", "private"]
Provider = Literal["gmail", "icloud", "namecheap", "hostinger", "other"]


class AccountIn(BaseModel):
    address: str = Field(min_length=3, max_length=254)
    provider: Provider = "other"
    label: str | None = Field(default=None, max_length=80)
    username: str | None = Field(default=None, max_length=254)
    imapHost: str | None = Field(default=None, max_length=253)
    imapPort: StrictInt | None = Field(default=None, ge=1, le=65535)
    smtpHost: str | None = Field(default=None, max_length=253)
    smtpPort: StrictInt | None = Field(default=None, ge=1, le=65535)
    scopeId: StrictInt | None = None
    confidentiality: Level = "normal"
    maxAgeDays: StrictInt = Field(default=60, ge=1, le=3650)
    password: str | None = Field(default=None, min_length=4, max_length=500)


class AccountChange(BaseModel):
    label: str | None = Field(default=None, max_length=80)
    username: str | None = Field(default=None, min_length=1, max_length=254)
    imapHost: str | None = Field(default=None, max_length=253)
    imapPort: StrictInt | None = Field(default=None, ge=1, le=65535)
    smtpHost: str | None = Field(default=None, max_length=253)
    smtpPort: StrictInt | None = Field(default=None, ge=1, le=65535)
    scopeId: StrictInt | None = None
    confidentiality: Level | None = None
    maxAgeDays: StrictInt | None = Field(default=None, ge=1, le=3650)
    enabled: StrictBool | None = None
    # A new password replaces the stored one; an explicit null forgets it.
    password: str | None = Field(default=None, min_length=4, max_length=500)


class ScopeIn(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r"\S")
    color: str | None = Field(default=None, pattern=r"^#[0-9a-f]{6}$")
    fiscal: StrictBool = False


def _slug(name: str) -> str:
    table = str.maketrans("áéíóúüñàèìòùç", "aeiouunaeiouc")
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower().translate(table)).strip("-")
    return slug[:40] or "ambito"


def sync_all(settings: Settings, secrets) -> None:
    connection = connect(settings.data_dir / DB_NAME)
    try:
        for row in connection.execute("SELECT id FROM mail_account WHERE enabled = 1").fetchall():
            try:  # one account failing never stops the others
                mail.sync_account(connection, row["id"], secrets.get(mail.secret_account(row["id"])))
            except Exception as error:
                print(f"AgoraOne núcleo: no se pudo leer una cuenta de correo ({type(error).__name__}).", file=sys.stderr)
    finally:
        connection.close()


def mail_worker(settings: Settings, secrets, stop: threading.Event) -> None:
    if stop.wait(15):  # a short pause so start-up is not slowed down
        return
    while True:
        try:
            sync_all(settings, secrets)
        except Exception as error:  # a failed round must not stop the core; the next one retries
            print(f"AgoraOne núcleo: no se pudo leer el correo ({type(error).__name__}).", file=sys.stderr)
        if stop.wait(SYNC_SECONDS):
            return


def mail_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def db(work):
        def task():
            with database() as connection:
                return work(connection)
        return run_in_threadpool(task)

    def has_password(account_id: int) -> bool:
        return bool(secrets.get(mail.secret_account(account_id)))

    async def accounts():
        return {"accounts": await db(lambda c: mail.list_accounts(c, has_password))}

    @router.get("/mail/presets")
    async def presets():
        return {"presets": {key: {"name": p.name, "imapHost": p.imap[0], "imapPort": p.imap[1], "smtpHost": p.smtp[0],
                                  "smtpPort": p.smtp[1], "hint": p.hint} for key, p in mail.PRESETS.items()}}

    @router.get("/mail/accounts")
    async def list_accounts():
        return await accounts()

    @router.post("/mail/accounts", status_code=201)
    async def create(body: AccountIn):
        data = body.model_dump(exclude={"password"})
        try:
            account_id = await db(lambda c: mail.create_account(c, data))
        except mail.MailError as error:
            return JSONResponse({"error": str(error)}, status_code=422)
        if body.password:
            await run_in_threadpool(secrets.put, mail.secret_account(account_id), body.password)
        return await accounts()

    @router.put("/mail/accounts/{account_id}")
    async def change(account_id: int, body: AccountChange):
        changes = body.model_dump(exclude_unset=True)
        password_given = "password" in changes
        password = changes.pop("password", None)
        try:
            await db(lambda c: mail.update_account(c, account_id, changes))
        except mail.MailError as error:
            return JSONResponse({"error": str(error)}, status_code=422)
        if password_given:
            await run_in_threadpool(secrets.put, mail.secret_account(account_id), password)
            await db(lambda c: c.execute("UPDATE mail_account SET status = 'pending', last_error = NULL WHERE id = ?", (account_id,)))
        return await accounts()

    @router.delete("/mail/accounts/{account_id}")
    async def remove(account_id: int):
        if not await db(lambda c: mail.delete_account(c, account_id)):
            return JSONResponse({"error": "Esa cuenta no existe."}, status_code=404)
        await run_in_threadpool(secrets.put, mail.secret_account(account_id), None)
        return await accounts()

    @router.post("/mail/accounts/{account_id}/sync")
    async def sync_now(account_id: int):
        password = await run_in_threadpool(secrets.get, mail.secret_account(account_id))
        result = await db(lambda c: mail.sync_account(c, account_id, password, batch=mail.MANUAL_BATCH))
        if result["status"] == "missing":
            return JSONResponse({"error": "Esa cuenta no existe."}, status_code=404)
        return {"result": result, **(await accounts())}

    @router.get("/scopes")
    async def scopes():
        rows = await db(lambda c: c.execute("SELECT id, slug, name, color, fiscal FROM scope ORDER BY id").fetchall())
        return {"scopes": [{"id": r["id"], "slug": r["slug"], "name": r["name"], "color": r["color"], "fiscal": bool(r["fiscal"])} for r in rows]}

    @router.post("/scopes", status_code=201)
    async def create_scope(body: ScopeIn):
        def insert(c: sqlite3.Connection):
            base = slug = _slug(body.name)
            for n in range(2, 100):
                if not c.execute("SELECT 1 FROM scope WHERE slug = ?", (slug,)).fetchone():
                    break
                slug = f"{base[:36]}-{n}"
            c.execute("INSERT INTO scope (slug, name, color, fiscal, created_at) VALUES (?, ?, ?, ?, ?)",
                      (slug, body.name.strip(), body.color, int(body.fiscal), now()))
        await db(insert)
        return await scopes()

    return router
