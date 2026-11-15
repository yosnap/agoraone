"""HTTP routes of the local speech to text: what is installed and chosen, the settings, and transcribing a
short clip (dictation). The audio never leaves this machine; nothing is kept once transcribed."""

from contextlib import contextmanager

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import transcribe
from .db import DB_NAME, connect
from .settings import Settings

DICTATION_BYTES = 1024 * 1024  # what the server's proxy lets through: about a minute of compressed voice


class VoiceSettings(BaseModel):
    binary: str | None = None
    ffmpeg: str | None = None
    model: str | None = None
    language: str | None = None


def voice_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def refuse(error: Exception, status: int = 422):
        return JSONResponse({"error": str(error)}, status_code=status)

    @router.get("/voice/status")
    async def status():
        def work():
            with database() as connection:
                return transcribe.status(connection)
        return await run_in_threadpool(work)

    @router.put("/voice/settings")
    async def change(body: VoiceSettings):
        def work():
            with database() as connection:
                return transcribe.save_settings(connection, body.model_dump(exclude_unset=True))
        try:
            return await run_in_threadpool(work)
        except transcribe.VoiceError as error:
            return refuse(error)

    @router.post("/voice/transcribe")
    async def dictate(request: Request):
        audio = await request.body()
        if len(audio) > DICTATION_BYTES:
            return refuse(transcribe.VoiceError("El audio es demasiado largo para dictar: como mucho un minuto."), 413)
        def work():
            with database() as connection:
                return transcribe.transcribe(connection, audio)
        try:
            return await run_in_threadpool(work)
        except transcribe.VoiceBusy as error:
            return refuse(error, 409)
        except transcribe.VoiceError as error:
            return refuse(error)

    return router
