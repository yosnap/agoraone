"""HTTP routes of mail accounts and scopes, and the background reading of new mail every few minutes."""

import imaplib
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

from . import mail, mail_oauth, mail_rules
from .db import DB_NAME, connect, now, transaction
from .settings import Settings

SYNC_SECONDS = 300
Level = Literal["normal", "local_only", "private"]
Provider = Literal["gmail", "icloud", "microsoft", "other", "resend", "smtp"]
# Microsoft sign-ins in progress and access tokens in memory, shared by the routes and the background reader.
FLOWS = mail_oauth.Flows()


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
    inbound: StrictBool = True  # Resend: also read what it receives


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
    inbound: StrictBool | None = None
    # A new password replaces the stored one; an explicit null forgets it.
    password: str | None = Field(default=None, min_length=4, max_length=500)


class MicrosoftIn(BaseModel):
    clientId: str | None = Field(default=None, max_length=64)


class ScopeIn(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r"\S")
    color: str | None = Field(default=None, pattern=r"^#[0-9a-f]{6}$")
    fiscal: StrictBool = False


def _slug(name: str) -> str:
    table = str.maketrans("áéíóúüñàèìòùç", "aeiouunaeiouc")
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower().translate(table)).strip("-")
    return slug[:40] or "ambito"


def microsoft_token(connection, secrets):
    """`token(account, refresh)`: a Microsoft access token renewed from the Keychain (IMAP and SMTP), or None
    without a client id. Raises mail.LoginError with the reason."""
    client = mail_oauth.client_id(connection)
    if not client:
        return None

    def token(account, refresh):
        account_id = account["id"]
        try:
            return mail_oauth.access_token(FLOWS, account_id, client, refresh, lambda new: secrets.put(mail.secret_account(account_id), new))
        except mail_oauth.OAuthError as error:
            raise mail.LoginError(str(error)) from error
    return token


def microsoft_login(connection, secrets):
    """How Microsoft accounts sign in (XOAUTH2 with a token renewed from the Keychain), or None without a client id."""
    renew = microsoft_token(connection, secrets)
    if not renew:
        return None

    def login(imap, account, refresh):
        account_id = account["id"]
        token = renew(account, refresh)
        try:
            imap.authenticate("XOAUTH2", lambda _: mail_oauth.xoauth2(account["username"], token))
        except imaplib.IMAP4.error as error:
            with FLOWS.lock:
                FLOWS.tokens.pop(account_id, None)  # the next round asks Microsoft for a fresh one
            raise mail.LoginError("Outlook rechazó el acceso: comprueba que IMAP está activo en el buzón y que entraste en Microsoft "
                                  "con esta misma dirección.") from error
    return login


def sync_all(settings: Settings, secrets) -> None:
    connection = connect(settings.data_dir / DB_NAME)
    try:
        login = microsoft_login(connection, secrets)
        for row in connection.execute("SELECT id FROM mail_account WHERE enabled = 1 AND (kind = 'mailbox' OR inbound = 1)").fetchall():
            try:  # one account failing never stops the others
                mail.sync_account(connection, row["id"], secrets.get(mail.secret_account(row["id"])), login=login)
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
        if "confidentiality" in changes:
            # A stricter account takes its messages' summaries out of reach at once (Watson, the Bandeja).
            def relevel(c):
                with transaction(c):
                    mail_rules.reapply(c)
            await db(relevel)
        if password_given:
            await run_in_threadpool(secrets.put, mail.secret_account(account_id), password)
            await db(lambda c: c.execute("UPDATE mail_account SET status = 'pending', last_error = NULL WHERE id = ?", (account_id,)))
        return await accounts()

    @router.delete("/mail/accounts/{account_id}")
    async def remove(account_id: int):
        if not await db(lambda c: mail.delete_account(c, account_id)):
            return JSONResponse({"error": "Esa cuenta no existe."}, status_code=404)
        await run_in_threadpool(secrets.put, mail.secret_account(account_id), None)
        mail_oauth.forget(FLOWS, account_id)
        return await accounts()

    @router.post("/mail/accounts/{account_id}/sync")
    async def sync_now(account_id: int):
        password = await run_in_threadpool(secrets.get, mail.secret_account(account_id))
        result = await db(lambda c: mail.sync_account(c, account_id, password, batch=mail.MANUAL_BATCH, login=microsoft_login(c, secrets)))
        if result["status"] == "missing":
            return JSONResponse({"error": "Esa cuenta no existe."}, status_code=404)
        return {"result": result, **(await accounts())}

    @router.post("/mail/accounts/{account_id}/check")
    async def check_sender(account_id: int):
        """Signs in to an account's SMTP server (without sending anything) and says whether it worked."""
        from . import mail_send
        account = await db(lambda c: c.execute("SELECT * FROM mail_account WHERE id = ?", (account_id,)).fetchone())
        if account is None or account["kind"] != "send":
            return JSONResponse({"error": "Esa cuenta no es de solo envío."}, status_code=404)
        password = await run_in_threadpool(secrets.get, mail.secret_account(account_id))
        status, detail = await run_in_threadpool(mail_send.check_login, account["smtp_host"], account["smtp_port"], account["username"], password)
        # Only if the server and user are still the ones tried: an edit made meanwhile stays pending.
        await db(lambda c: c.execute("UPDATE mail_account SET status = ?, last_error = ? WHERE id = ? AND smtp_host = ? AND smtp_port = ? AND username = ?",
                                     (status, None if status == "ok" else detail, account_id, account["smtp_host"], account["smtp_port"], account["username"])))
        return {"result": {"status": status, "detail": detail}, **(await accounts())}

    @router.get("/mail/microsoft")
    async def microsoft_settings():
        return {"clientId": await db(mail_oauth.client_id)}

    @router.put("/mail/microsoft")
    async def save_microsoft(body: MicrosoftIn):
        try:
            await db(lambda c: mail_oauth.save_client_id(c, body.clientId))
        except mail_oauth.OAuthError as error:
            return JSONResponse({"error": str(error)}, status_code=422)
        return {"clientId": await db(mail_oauth.client_id)}

    def describe(pending: mail_oauth.Pending | None) -> dict:
        if pending is None:
            return {"state": "none"}
        return {"state": pending.current_state(), "message": pending.message, "userCode": pending.user_code,
                "verificationUri": pending.verification_uri, "expiresAt": int(pending.expires_at)}

    @router.post("/mail/accounts/{account_id}/microsoft")
    async def connect_microsoft(account_id: int):
        row = await db(lambda c: c.execute("SELECT auth FROM mail_account WHERE id = ?", (account_id,)).fetchone())
        if row is None or row["auth"] != "microsoft":
            return JSONResponse({"error": "Esa cuenta no es de Microsoft."}, status_code=404)
        client = await db(mail_oauth.client_id)
        if not client:
            return JSONResponse({"error": "Falta el identificador de la aplicación de Microsoft en Ajustes › Cuentas de correo."}, status_code=422)

        def saved(refresh: str) -> bool:  # runs in the waiting thread once the user accepts
            with database() as c:
                current = c.execute("SELECT auth FROM mail_account WHERE id = ?", (account_id,)).fetchone()
                if current is None or current["auth"] != "microsoft":
                    return False  # deleted meanwhile (its id may now be another account's): nothing is stored
                secrets.put(mail.secret_account(account_id), refresh)
                c.execute("UPDATE mail_account SET status = 'pending', last_error = NULL WHERE id = ?", (account_id,))
            return True
        try:
            pending = await run_in_threadpool(mail_oauth.start, FLOWS, account_id, client, saved)
        except mail_oauth.OAuthError as error:
            return JSONResponse({"error": str(error)}, status_code=502)
        return describe(pending)

    @router.get("/mail/accounts/{account_id}/microsoft")
    async def microsoft_status(account_id: int):
        with FLOWS.lock:
            pending = FLOWS.pending.get(account_id)
        return describe(pending)

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
