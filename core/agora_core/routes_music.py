"""HTTP routes of the music: what plays, the controls and «pon …». Only from the owner's screen."""

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import music


class Control(BaseModel):
    player: str
    action: str


class Play(BaseModel):
    player: str
    query: str


def music_router() -> APIRouter:
    router = APIRouter()

    async def run(work):
        try:
            return await run_in_threadpool(work)
        except music.MusicError as error:
            return JSONResponse({"error": str(error)}, status_code=422)

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
