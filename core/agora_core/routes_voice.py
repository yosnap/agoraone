"""HTTP routes of the local speech to text: what is installed and chosen, the settings, and transcribing a
short clip (dictation). The audio never leaves this machine; nothing is kept once transcribed."""

import threading
from contextlib import contextmanager

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from . import transcribe, tts
from .db import DB_NAME, connect
from .settings import Settings

DICTATION_BYTES = 1024 * 1024  # what the server's proxy lets through: about a minute of compressed voice


class TtsSettings(BaseModel):
    engine: str | None = None
    voice: str | None = None
    speed: float | None = None
    macVoice: str | None = None
    quality: str | None = None
    openAtStart: bool | None = None


class SpeakText(BaseModel):
    text: str


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

    # Watson's voice (1.7): the chosen engine and voice, what speaks now and the voices VoiceStudio offers.
    def tts_view(connection) -> dict:
        chosen = tts.settings(connection)
        voices = tts.voicestudio_voices(fresh=True)
        return {"settings": chosen, "now": tts.resolve(chosen, voices), "voicestudio": voices,
                "opening": tts._launch["state"] == "opening", "installed": tts.installed_app() is not None,
                "running": voices is not None or tts.app_running()}

    @router.get("/voice/tts")
    async def tts_get():
        def job():
            with database() as connection:
                return tts_view(connection)
        return await run_in_threadpool(job)

    @router.put("/voice/tts")
    async def tts_put(body: TtsSettings):
        def job():
            with database() as connection:
                tts.save_settings(connection, body.model_dump(exclude_unset=True))
                return tts_view(connection)
        try:
            return await run_in_threadpool(job)
        except tts.TtsError as error:
            return refuse(error)

    @router.post("/voice/speak")
    async def tts_speak(body: SpeakText):
        def job():
            with database() as connection:
                now = tts.resolve(tts.settings(connection), tts.voicestudio_voices())
            if now["engine"] != "voicestudio":
                raise tts.TtsError(now["problem"] or "La voz elegida es la de macOS.")
            return tts.synthesize(now["voice"], body.text, steps=now["steps"])
        try:
            return Response(await run_in_threadpool(job), media_type="audio/wav")
        except tts.TtsError as error:
            return refuse(error, 503)

    @router.post("/voice/warm")
    async def tts_warm():
        """A question was just sent: get VoiceStudio's voice ready while Watson thinks (in the background)."""
        def job():
            with database() as connection:
                chosen = tts.settings(connection)
            threading.Thread(target=tts.warm, args=(chosen,), daemon=True).start()
        await run_in_threadpool(job)
        return {"ok": True}

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
