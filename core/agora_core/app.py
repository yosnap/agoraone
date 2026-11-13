"""Aplicación HTTP del núcleo.

Solo el backend de AgoraOne llega aquí: cada petición trae el secreto del arranque en curso y el
propietario ya autenticado por la cookie de acceso. El navegador nunca habla directamente con el núcleo.
"""

import hmac
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__
from .settings import Settings

SECRET_HEADER = "x-agora-core-secret"
OWNER_HEADER = "x-agora-owner"
_OWNER = re.compile(r"[a-f0-9]{64}")


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(title="AgoraOne núcleo", docs_url=None, redoc_url=None, openapi_url=None)
    expected = settings.secret.encode()

    @app.middleware("http")
    async def only_agoraone(request: Request, call_next):
        if request.headers.get("host") != settings.authority:
            return JSONResponse({"error": "Host no permitido."}, status_code=403)
        given = request.headers.get(SECRET_HEADER, "").encode()
        if not hmac.compare_digest(given, expected):
            return JSONResponse({"error": "Petición no autorizada."}, status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/health")
    async def health():
        return {"status": "ok", "version": __version__}

    @app.get("/whoami")
    async def whoami(request: Request):
        owner = request.headers.get(OWNER_HEADER, "")
        if not _OWNER.fullmatch(owner):
            return JSONResponse({"error": "Falta el propietario."}, status_code=400)
        return {"owner": owner}

    return app
