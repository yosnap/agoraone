"""HTTP routes for replying to and sending mail: a reply prefilled from a received mail, a body drafted by
Watson (only for mail the model may read), the sealed preview, and the send itself, only with the user's
«Enviar» on exactly that preview (user's decision, 14/11/2026)."""

import asyncio
from contextlib import aclosing, contextmanager
from typing import Annotated

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictInt

from . import mail, mail_inbox, mail_send
from .db import DB_NAME, connect
from .engines import AnthropicApiEngine, ClaudeCodeEngine, Turn, usable
from .routes_mail import microsoft_token
from .settings import Settings


class DraftIn(BaseModel):
    accountId: StrictInt
    to: Annotated[str, Field(max_length=4000)]
    cc: Annotated[str, Field(max_length=4000)] = ""
    subject: Annotated[str, Field(max_length=1000)] = ""
    body: Annotated[str, Field(max_length=mail_send.MAX_BODY + 1000)]
    replyTo: StrictInt | None = None


class SendIn(BaseModel):
    draft: DraftIn
    digest: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class ComposeIn(BaseModel):
    instructions: Annotated[str, Field(max_length=2000)] = ""


def mail_send_router(settings: Settings, secrets, drafter=None) -> APIRouter:
    """`drafter(system, text)` writes with a model; by default the user's Claude Code session, then the API key."""
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    async def db(work):
        def run():
            with database() as connection:
                return work(connection)
        return await run_in_threadpool(run)

    def refuse(error: Exception, status: int = 422):
        return JSONResponse({"error": str(error)}, status_code=status)

    def default_drafter(system: str, text: str) -> str:
        engines = [e for e in usable([ClaudeCodeEngine(settings.data_dir / "claude-code"), AnthropicApiEngine(secrets)])
                   if e.name in ("claude-code", "anthropic-api")]
        error: Exception | None = None
        for engine in engines:
            async def run(engine=engine):
                parts = []
                async with aclosing(engine.stream(Turn(system, [{"role": "user", "content": text}], "sonnet"))) as stream:
                    async for piece in stream:
                        if piece:
                            parts.append(piece)
                return "".join(parts)
            try:
                return asyncio.run(run())
            except Exception as failure:  # noqa: BLE001 - try the next engine
                error = failure
        raise mail_send.SendError("No hay ningún motor de Claude disponible para redactar." if error is None else "El asistente no ha podido redactar ahora.")

    write = drafter or default_drafter

    @router.get("/mail/messages/{message_id}/reply")
    async def reply(message_id: int):
        try:
            return await db(lambda c: mail_send.reply_draft(c, message_id))
        except mail_send.SendError as error:
            return refuse(error, 404)

    @router.post("/mail/messages/{message_id}/compose")
    async def compose(message_id: int, body: ComposeIn):
        try:
            return {"body": await db(lambda c: mail_send.compose(c, message_id, body.instructions, write))}
        except mail_send.SendError as error:
            return refuse(error)

    @router.post("/mail/drafts/preview")
    async def preview(body: DraftIn):
        """Exactly what will be sent, and its seal: «Enviar» sends only this."""
        try:
            draft = mail_send.clean(body.model_dump())
        except mail_send.SendError as error:
            return refuse(error)

        def account(connection):
            return connection.execute("SELECT address, label FROM mail_account WHERE id = ?", (draft["accountId"],)).fetchone()
        found = await db(account)
        if found is None:
            return refuse(mail_send.SendError("Esa cuenta no existe."))
        sender = f"{found['label']} <{found['address']}>" if found["label"] else found["address"]
        return {"draft": draft, "from": sender, "digest": mail_send.digest(draft), "attachments": []}

    @router.post("/mail/send", status_code=201)
    async def send(body: SendIn):
        secret = await run_in_threadpool(secrets.get, mail.secret_account(body.draft.accountId)) if secrets else None

        def work(connection):
            renew = microsoft_token(connection, secrets) if secrets else None
            result = mail_send.send(connection, body.draft.model_dump(), body.digest, secret, token=renew)
            if body.draft.replyTo:
                mail_inbox.decide(connection, body.draft.replyTo, "done")
            return result
        try:
            return await db(work)
        except (mail_send.SendError, mail.LoginError) as error:
            return refuse(error)

    return router
