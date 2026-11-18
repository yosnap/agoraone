"""HTTP routes of WhatsApp (through Zernio), read-only: the key in the Keychain, a test, «Leer ahora» and each
account's scope, confidentiality and days back. The key is never returned: only whether there is one."""

import sqlite3
from typing import Literal

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool, StrictInt

from . import chat_sync, zernio
from .db import DB_NAME, connect
from .settings import Settings

Level = Literal["normal", "local_only", "private"]


class KeyIn(BaseModel):
    # null forgets it. Checked in the route, not here: a validation error would echo the key back.
    key: str | None = None


def key_problem(key: str | None) -> str | None:
    if key is None:
        return None
    key = key.strip()
    if not 8 <= len(key) <= 500 or not key.isascii() or not key.isprintable() or any(c.isspace() for c in key):
        return "La clave de API de Zernio no parece válida: cópiala entera desde su panel, sin espacios."
    return None


class AccountChange(BaseModel):
    scopeId: StrictInt | None = None
    confidentiality: Level | None = None
    maxAgeDays: StrictInt | None = Field(default=None, ge=1, le=3650)
    enabled: StrictBool | None = None


def list_accounts(connection: sqlite3.Connection) -> list[dict]:
    rows = connection.execute(
        """SELECT a.*, s.name AS scope_name,
                  (SELECT count(*) FROM chat_conversation c WHERE c.account_id = a.id) AS conversations,
                  (SELECT count(*) FROM chat_message m JOIN chat_conversation c ON c.id = m.conversation_id WHERE c.account_id = a.id) AS messages
           FROM chat_account a LEFT JOIN scope s ON s.id = a.scope_id ORDER BY a.id""").fetchall()
    return [{"id": r["id"], "provider": r["provider"], "phone": r["phone"], "label": r["label"], "scopeId": r["scope_id"], "scopeName": r["scope_name"],
             "confidentiality": r["confidentiality"], "maxAgeDays": r["max_age_days"], "enabled": bool(r["enabled"]), "status": r["status"],
             "lastError": r["last_error"], "lastSyncAt": r["last_sync_at"], "conversations": r["conversations"], "messages": r["messages"]} for r in rows]


def update_account(connection: sqlite3.Connection, account_id: int, changes: dict) -> str | None:
    """Applies the user's changes; returns the reason when they cannot be applied."""
    if not connection.execute("SELECT 1 FROM chat_account WHERE id = ?", (account_id,)).fetchone():
        return "Esa cuenta no existe."
    if changes.get("scopeId") is not None and not connection.execute("SELECT 1 FROM scope WHERE id = ?", (changes["scopeId"],)).fetchone():
        return "Ese ámbito no existe."
    if any(changes.get(name, "") is None for name in ("confidentiality", "maxAgeDays", "enabled")):
        return "Falta un dato obligatorio de la cuenta."
    columns = {"scopeId": "scope_id", "confidentiality": "confidentiality", "maxAgeDays": "max_age_days", "enabled": "enabled"}
    values = {columns[name]: int(value) if name == "enabled" else value for name, value in changes.items() if name in columns}
    if values:
        connection.execute(f"UPDATE chat_account SET {', '.join(f'{column} = ?' for column in values)} WHERE id = ?", (*values.values(), account_id))
    return None


def chat_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()

    def db(work):
        def task():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                return work(connection)
            finally:
                connection.close()
        return run_in_threadpool(task)

    async def has_key() -> bool:
        return bool(await run_in_threadpool(secrets.get, zernio.SECRET))

    async def described() -> dict:
        accounts, last = await db(lambda c: (list_accounts(c), chat_sync.last_result(c)))
        return {"hasKey": await has_key(), "accounts": accounts, "lastSync": last}

    @router.get("/chat/settings")
    async def chat_settings():
        return await described()

    @router.put("/chat/key")
    async def save_key(body: KeyIn):
        problem = key_problem(body.key)
        if problem:
            return JSONResponse({"error": problem}, status_code=422)
        await run_in_threadpool(secrets.put, zernio.SECRET, body.key.strip() if body.key else None)
        await db(lambda c: c.execute("UPDATE chat_account SET status = 'pending', last_error = NULL"))
        return await described()

    @router.post("/chat/test")
    async def test():
        key = await run_in_threadpool(secrets.get, zernio.SECRET)
        if not key:
            return JSONResponse({"error": "Guarda antes la clave de API de Zernio."}, status_code=422)
        try:
            found = await run_in_threadpool(zernio.accounts, key)
        except zernio.ZernioError as error:
            return JSONResponse({"error": str(error), "status": error.status}, status_code=502)
        whatsapp = [a for a in found if str(a.get("platform") or "").lower() == "whatsapp"]
        return {"whatsapp": len(whatsapp), "others": len(found) - len(whatsapp)}

    @router.post("/chat/sync")
    async def sync_now():
        key = await run_in_threadpool(secrets.get, zernio.SECRET)
        if not key:
            return JSONResponse({"error": "Guarda antes la clave de API de Zernio."}, status_code=422)
        result = await db(lambda c: chat_sync.sync(c, key))
        return {"result": result, **(await described())}

    @router.patch("/chat/accounts/{account_id}")
    async def change(account_id: int, body: AccountChange):
        problem = await db(lambda c: update_account(c, account_id, body.model_dump(exclude_unset=True)))
        if problem:
            return JSONResponse({"error": problem}, status_code=404 if problem == "Esa cuenta no existe." else 422)
        return await described()

    return router
