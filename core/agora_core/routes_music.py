"""HTTP routes of the music: what plays, the controls and «pon …». Only from the owner's screen."""

from contextlib import contextmanager

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from . import hidden_player, music, music_library, youtube
from .db import DB_NAME, connect
from .settings import Settings


class Control(BaseModel):
    player: str
    action: str


class Play(BaseModel):
    player: str
    query: str


class Folders(BaseModel):
    folders: list[str]


class Query(BaseModel):
    query: str


class HiddenCommand(BaseModel):
    action: str
    id: str | None = None
    volume: float | None = None
    seconds: float | None = None


def music_router(settings: Settings, relay: hidden_player.Relay | None = None) -> APIRouter:
    router = APIRouter()
    relay = relay or hidden_player.Relay()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    async def run(work):
        try:
            return await run_in_threadpool(work)
        except (music.MusicError, music_library.LibraryError) as error:
            return JSONResponse({"error": str(error), "reason": getattr(error, "reason", None)}, status_code=422)

    def with_db(work):
        def job():
            with database() as connection:
                return work(connection)
        return job

    @router.get("/music/library")
    async def library(q: str = ""):
        return await run(with_db(lambda c: {"folders": music_library.folders(c), "tracks": music_library.search(c, q),
                                            "total": len(music_library.index(music_library.folders(c)))}))

    @router.put("/music/library/folders")
    async def library_folders(body: Folders):
        return await run(with_db(lambda c: {"folders": music_library.save_folders(c, body.folders)}))

    @router.post("/music/library/choose")
    async def library_choose():
        return await run(lambda: {"path": music_library.choose()})

    @router.get("/music/library/{ident}/file")
    async def library_file(ident: str):
        found = await run(with_db(lambda c: music_library.file_of(c, ident)))
        if isinstance(found, JSONResponse):
            return found
        return FileResponse(found[0], media_type=found[1], headers={"Cache-Control": "no-store"})

    @router.get("/music/youtube/search")
    async def youtube_search(q: str = ""):
        try:
            return {"videos": await run_in_threadpool(youtube.search, q)}
        except youtube.YouTubeError as error:
            return JSONResponse({"error": str(error)}, status_code=422)

    @router.post("/music/youtube")
    async def youtube_in_browser(body: Query):  # not «youtube»: that name is the module used just above
        return await run(lambda: {"done": music_library.youtube(body.query)})

    @router.get("/music/youtube/hidden")
    async def hidden_available():
        return {"available": relay.available()}

    @router.post("/music/youtube/hidden")
    async def hidden_command(body: HiddenCommand):
        command = hidden_player.valid(body.model_dump(exclude_none=True))
        if command is None:
            return JSONResponse({"error": "Orden no válida."}, status_code=400)
        if not relay.available():
            return JSONResponse({"error": "La ventana de YouTube solo existe en la app de escritorio."}, status_code=409)
        return {"seq": relay.push(command)}

    @router.get("/internal/youtube/hidden/next")  # only the desktop app: the browser cannot reach /internal
    async def hidden_next(after: int = -1):
        return await relay.next(after)

    @router.get("/music/status")
    async def now_playing():
        return await run(music.status)

    @router.post("/music/control")
    async def control(body: Control):
        return await run(lambda: music.control(body.player, body.action) or music.status())

    @router.post("/music/play")
    async def play(body: Play):
        return await run(lambda: {"done": music.play(body.player, body.query), **music.status()})

    return router
