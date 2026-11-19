"""HTTP routes for replying on WhatsApp: an empty reply with Meta's 24 h window, a text drafted by Watson (only for
conversations the model may read), the sealed preview and the send itself, only with the user's «Enviar» on exactly
that preview (user's decision, 18/11/2026). No Watson route reaches the send, and nothing here acts on what a
message says."""

from typing import Annotated

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictInt

from . import chat_inbox, chat_send, mail_send, zernio
from .db import DB_NAME, connect
from .routes_mail_send import claude_drafter
from .settings import Settings


class ChatDraftIn(BaseModel):
    conversationId: StrictInt
    text: Annotated[str, Field(max_length=chat_send.MAX_TEXT + 1000)]


class ChatSendIn(BaseModel):
    draft: ChatDraftIn
    digest: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class ChatComposeIn(BaseModel):
    instructions: Annotated[str, Field(max_length=2000)] = ""


def chat_send_router(settings: Settings, secrets, drafter=None) -> APIRouter:
    """`drafter(system, text)` writes with a model; by default the user's Claude Code session, then the API key."""
    router = APIRouter()
    write = drafter or claude_drafter(settings, secrets)

    async def db(work):
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                return work(connection)
            finally:
                connection.close()
        return await run_in_threadpool(run)

    def refuse(error: chat_send.ChatSendError) -> JSONResponse:
        return JSONResponse({"error": str(error), **({"outcome": error.outcome} if error.outcome else {})}, status_code=error.status)

    @router.get("/chat/summaries/{conversation_id}/reply")
    async def reply(conversation_id: int):
        try:
            return await db(lambda c: chat_send.reply_draft(c, conversation_id))
        except chat_send.ChatSendError as error:
            return refuse(error)

    @router.post("/chat/summaries/{conversation_id}/compose")
    async def compose(conversation_id: int, body: ChatComposeIn):
        try:
            return {"text": await db(lambda c: chat_send.compose(c, conversation_id, body.instructions, write))}
        except chat_send.ChatSendError as error:
            return refuse(error)
        except mail_send.SendError as error:  # no engine could draft
            return JSONResponse({"error": str(error)}, status_code=422)

    @router.post("/chat/drafts/preview")
    async def preview(body: ChatDraftIn):
        """Exactly what will be sent, its seal and the window now: «Enviar» sends only this."""
        try:
            return await db(lambda c: chat_send.preview(c, body.model_dump()))
        except chat_send.ChatSendError as error:
            return refuse(error)

    @router.post("/chat/send", status_code=201)
    async def send(body: ChatSendIn):
        key = await run_in_threadpool(secrets.get, zernio.SECRET) if secrets else None

        def work(connection):
            result = chat_send.send(connection, body.draft.model_dump(), body.digest, key)
            try:  # the message left: the card goes to «Hechos», and a failure here must not look like a failed send
                chat_inbox.decide(connection, body.draft.conversationId, "done")
            except Exception:  # noqa: BLE001
                pass
            return result
        try:
            return await db(work)
        except chat_send.ChatSendError as error:
            return refuse(error)

    return router
