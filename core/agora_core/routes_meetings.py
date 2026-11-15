"""HTTP routes of recorded meetings: start (with or without the system's audio), the microphone in pieces,
stop, list and delete. Each meeting belongs to the access that recorded it."""

import re
from contextlib import contextmanager

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import system_audio
from .db import DB_NAME, connect
from .meetings import MeetingError, Recorder
from .settings import Settings

_OWNER = re.compile(r"[0-9a-f]{64}")


class NewMeeting(BaseModel):
    title: str = ""
    confidentiality: str = "normal"
    mic_type: str
    system: bool = True


def meetings_router(settings: Settings, recorder: Recorder) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    async def run(request: Request, work):
        owner = request.headers.get("x-agora-owner", "")
        if not _OWNER.fullmatch(owner):
            return JSONResponse({"error": "Falta el acceso."}, status_code=401)
        def job():
            with database() as connection:
                return work(connection, owner)
        try:
            return await run_in_threadpool(job)
        except MeetingError as error:
            return JSONResponse({"error": str(error)}, status_code=error.status)

    @router.get("/meetings")
    async def listing(request: Request):
        def work(connection, owner):
            meetings = recorder.list(connection, owner)
            return {"meetings": meetings, "system": system_audio.adapter()["note"],
                    "recording": next((m["id"] for m in meetings if m["status"] == "recording"), None)}
        return await run(request, work)

    @router.post("/meetings")
    async def start(request: Request, body: NewMeeting):
        return await run(request, lambda c, o: recorder.start(c, o, body.title, body.confidentiality, body.mic_type, body.system))

    @router.post("/meetings/{meeting_id}/mic")
    async def piece(request: Request, meeting_id: int):
        audio = await request.body()
        return await run(request, lambda c, o: recorder.piece(c, o, meeting_id, audio))

    @router.post("/meetings/{meeting_id}/stop")
    async def stop(request: Request, meeting_id: int):
        return await run(request, lambda c, o: recorder.stop(c, o, meeting_id))

    @router.delete("/meetings/{meeting_id}")
    async def delete(request: Request, meeting_id: int):
        return await run(request, lambda c, o: recorder.delete(c, o, meeting_id) or {"deleted": True})

    return router
