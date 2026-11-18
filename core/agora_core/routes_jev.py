"""HTTP routes of Jev (TypeSafe): the key in the Keychain, a test that costs no tokens, and the settings (model,
monthly cap, confidence threshold and each decision point's switch) with this month's use. The key is never
returned: only whether there is one."""

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool

from . import jev
from .db import DB_NAME, connect
from .settings import Settings


class KeyIn(BaseModel):
    # null forgets it. Checked in the route, not here: a validation error would echo the key back.
    key: object = None


def key_problem(key: object) -> str | None:
    if key is None:
        return None
    if not isinstance(key, str):
        return "La clave de API de TypeSafe debe ser texto."
    key = key.strip()
    if not 8 <= len(key) <= 500 or not key.isascii() or not key.isprintable() or any(c.isspace() for c in key):
        return "La clave de API de TypeSafe no parece válida: cópiala entera desde console.typesafe.ai, sin espacios."
    return None


class SettingsIn(BaseModel):
    model: str | None = Field(default=None, max_length=60)
    monthlyUsd: float | None = Field(default=None, gt=0, le=100)
    threshold: float | None = Field(default=None, ge=0.5, le=1)
    points: dict[str, StrictBool] | None = None


def jev_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()

    def db(work):
        def task():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                return work(connection)
            finally:
                connection.close()
        return run_in_threadpool(task)

    async def described() -> dict:
        has_key = bool(await run_in_threadpool(secrets.get, jev.SECRET))
        current, used = await db(lambda c: (jev.settings(c), jev.usage(c)))
        return {"hasKey": has_key, **current, "pointLabels": jev.POINTS, "aliases": list(jev.MODEL_ALIASES),
                "usage": {**{k: used[k] for k in ("month", "calls", "inputTokens", "outputTokens", "spentUsd")}, "capTokens": jev.cap_tokens(current["monthlyUsd"])}}

    @router.get("/jev/settings")
    async def jev_settings():
        return await described()

    @router.put("/jev/settings")
    async def change(body: SettingsIn):
        changes = body.model_dump(exclude_unset=True)
        if "model" in changes:
            problem = jev.model_problem(changes["model"])
            if problem:
                return JSONResponse({"error": problem}, status_code=422)
        if any(changes.get(name, "") is None for name in ("model", "monthlyUsd", "threshold", "points")):
            return JSONResponse({"error": "Falta un dato del ajuste de Jev."}, status_code=422)
        if any(name not in jev.POINTS for name in changes.get("points") or {}):
            return JSONResponse({"error": "Ese punto de decisión no existe."}, status_code=422)
        await db(lambda c: jev.save_settings(c, changes))
        return await described()

    @router.put("/jev/key")
    async def save_key(body: KeyIn):
        problem = key_problem(body.key)
        if problem:
            return JSONResponse({"error": problem}, status_code=422)
        await run_in_threadpool(secrets.put, jev.SECRET, body.key.strip() if isinstance(body.key, str) else None)
        return await described()

    @router.post("/jev/test")
    async def test():
        key = await run_in_threadpool(secrets.get, jev.SECRET)
        if not key:
            return JSONResponse({"error": "Guarda antes la clave de API de TypeSafe."}, status_code=422)
        try:
            found = await run_in_threadpool(jev.models, key)
        except jev.JevError as error:
            return JSONResponse({"error": str(error), "status": error.status}, status_code=502)
        return {"models": found}

    return router
