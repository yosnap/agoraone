"""HTTP routes of recorded meetings: start (with or without the system's audio), the microphone in pieces,
stop, list and delete. Each meeting belongs to the access that recorded it."""

import re
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import json

from . import fiscal, local_model, meeting_notes, system_audio
from .db import DB_NAME, connect, transaction
from .meetings import MeetingError, Recorder
from .settings import Settings

_OWNER = re.compile(r"[0-9a-f]{64}")


class Process(BaseModel):
    summary_only: bool = False


class Saved(BaseModel):
    vault: str
    note: str


class LocalSettings(BaseModel):
    local_url: str | None = None
    local_model: str | None = None
    auto: bool | None = None


class NewMeeting(BaseModel):
    title: str = ""
    confidentiality: str = "normal"
    mic_type: str
    system: bool = True
    kind: str = "meeting"
    client: str | None = None
    people: list[str] = []


class Changes(BaseModel):
    title: str | None = None
    kind: str | None = None
    client: str | None = None
    people: list[str] | None = None


def downloads() -> Path:
    """The user's Downloads folder (or their home when there is none)."""
    folder = Path.home() / "Downloads"
    return folder if folder.is_dir() else Path.home()


def meetings_router(settings: Settings, recorder: Recorder, worker: meeting_notes.Worker) -> APIRouter:
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
        except local_model.LocalModelError as error:
            return JSONResponse({"error": str(error)}, status_code=422)
        except (ValueError, RuntimeError) as error:
            return JSONResponse({"error": str(error)}, status_code=409)

    @router.get("/meetings")
    async def listing(request: Request):
        def work(connection, owner):
            meetings = recorder.list(connection, owner)
            return {"meetings": meetings, "system": system_audio.adapter()["note"],
                    "recording": next((m["id"] for m in meetings if m["status"] == "recording"), None)}
        return await run(request, work)

    # Before /meetings/{meeting_id}, so these names are not taken for an id.
    @router.get("/meetings/settings")
    async def get_local(request: Request):
        return await run(request, lambda c, o: {**meeting_notes.settings(c), "known": local_model.KNOWN, "detected": local_model.detect()})

    @router.put("/meetings/settings")
    async def put_local(request: Request, body: LocalSettings):
        return await run(request, lambda c, o: meeting_notes.save_settings(c, body.model_dump(exclude_unset=True)))

    @router.get("/meetings/summarizers")
    async def who(request: Request):
        return await run(request, lambda c, o: meeting_notes.summarizers(worker.make_engines(), meeting_notes.settings(c)))

    @router.get("/meetings/local-models")
    async def local_models(request: Request, url: str):
        return await run(request, lambda c, o: {"models": local_model.models(url)})

    @router.get("/meetings/{meeting_id}")
    async def detail(request: Request, meeting_id: int):
        def work(connection, owner):
            row = recorder.owned(connection, owner, meeting_id)
            return {**recorder.view(row), "transcript": json.loads(row["transcript"] or "[]"),
                    "summary": json.loads(row["summary"]) if row["summary"] else None, "draft": meeting_notes.note(row) if row["transcript"] else None}
        return await run(request, work)

    @router.patch("/meetings/{meeting_id}")
    async def change(request: Request, meeting_id: int, body: Changes):
        return await run(request, lambda c, o: recorder.update(c, o, meeting_id, body.model_dump(exclude_unset=True)))

    @router.post("/meetings/{meeting_id}/export")
    async def export(request: Request, meeting_id: int):
        """The whole meeting as a Markdown file in Downloads, shown selected in the Finder."""
        def work(connection, owner):
            row = recorder.owned(connection, owner, meeting_id)
            if not row["transcript"]:
                raise MeetingError("Todavía no hay transcripción que exportar.")
            path = meeting_notes.export(row, downloads())
            try:
                fiscal.open_in_finder(path.parent, path.name, reveal=True)
            except fiscal.FiscalError:
                pass  # the file is there even if the Finder could not show it
            return {"path": str(path), "name": path.name}
        return await run(request, work)

    @router.post("/meetings/{meeting_id}/process")
    async def process(request: Request, meeting_id: int, body: Process):
        def work(connection, owner):
            worker.begin(connection, recorder.owned(connection, owner, meeting_id), body.summary_only)
            return recorder.view(recorder.owned(connection, owner, meeting_id))
        return await run(request, work)

    @router.post("/meetings/{meeting_id}/saved")
    async def saved(request: Request, meeting_id: int, body: Saved):
        def work(connection, owner):
            recorder.owned(connection, owner, meeting_id)
            if not (0 < len(body.vault) <= 200 and 0 < len(body.note) <= 1000):
                raise MeetingError("Nota no válida.")
            with transaction(connection):
                connection.execute("UPDATE meeting SET saved_note = ? WHERE id = ? AND owner = ?", (json.dumps({"vault": body.vault, "note": body.note}), meeting_id, owner))
            return recorder.view(recorder.owned(connection, owner, meeting_id))
        return await run(request, work)

    @router.post("/meetings")
    async def start(request: Request, body: NewMeeting):
        return await run(request, lambda c, o: recorder.start(c, o, body.title, body.confidentiality, body.mic_type, body.system, body.kind, body.client, body.people))

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
