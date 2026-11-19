"""The routes of a connector's own web in a window of the desktop app (Central, CRMDev…), never in a frame: the window
loads the connector's web as its main page with a session store of its own, and the user signs in there with the
connector's own login; AgoraOne's key for its API never goes there. A connector with a web declares its pages, its
modules and its sentences, and `window_router` builds the same routes for each one:

- `POST /{label}/window` (`{ruta}`) leaves an order for the desktop app, which collects it at
  `GET /internal/{label}/window/next` like the hidden YouTube window (the browser cannot reach `/internal`). The
  route comes from the connector's closed list (`route_of`), so the screen can only open the connector's own pages,
  and the address is the connector's saved URL. Without the desktop app (AgoraOne in a browser tab) the answer is
  409 `no_window`, and `POST /{label}/window/browser` opens the same page in the system's browser instead.
- A link of the connector's web to another site is never followed inside the window: the desktop app tells
  AgoraOne's window, which offers it, and `POST /{label}/window/external` (`{url}`, http or https; the screen warns
  first when it is not encrypted) opens it in the system's browser.
- `POST /{label}/window/close` closes the window (discreet mode turned on) and `POST /{label}/window/check` makes the
  desktop app look again at once; each answer of `/internal/.../next` says whether the window may stay (`allowed`: a
  module that uses it is on) and the saved address (`url`): with the module off, the address removed or changed, the
  desktop app closes it.

An address on 127.0.0.1 or ::1 is never opened in the window (422 `loopback_ip`): that is AgoraOne's own host, and
cookies go by host, not by port, so on a Mac without a store of its own for the window AgoraOne's access cookie would
reach it. The browser can still open it. With the page's module off the routes answer 404, except `close`, `check`
and `/internal`."""

import sqlite3
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import modules
from .db import DB_NAME, connect
from .hidden_player import Relay
from .settings import Settings
from .window_links import agora_host, external_url, open_in_browser

BAD_URL = "Solo se abren en el navegador direcciones web (http o https)."
NO_BROWSER = "No se pudo abrir el navegador."


class RouteIn(BaseModel):
    ruta: object = None


class UrlIn(BaseModel):
    url: object = None


@dataclass(frozen=True)
class WindowTexts:
    """What the routes say. `off` maps each module that uses the window to the sentence of its being off: the first one
    is the module of a page not on the list, and any of them on keeps the window open."""
    off: Mapping[str, str]
    not_connected: str
    bad_route: str
    no_window: str
    loopback_ip: str


def page_url(base: str, route: str) -> str:
    return f"{base}/{route}" if route else f"{base}/"


def window_router(settings: Settings, label: str, base_url: Callable[[sqlite3.Connection], str | None],
                  route_of: Callable[[object], tuple[str, str] | None], texts: WindowTexts, relay: Relay | None = None) -> APIRouter:
    """The window routes of the connector `label`. `route_of` gives the page and the module it needs, or None when the
    page is not on the connector's closed list; `base_url` reads the connector's saved address (None: not saved)."""
    router = APIRouter()
    relay = relay or Relay()
    users = tuple(texts.off)
    default = users[0]

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def problem(status: int, message: str, kind: str) -> JSONResponse:
        return JSONResponse({"error": message, "status": kind}, status_code=status)

    def lookup() -> tuple[dict[str, bool], str | None]:
        with database() as connection:
            return modules.state(connection), base_url(connection)

    async def target(value: object, window: bool = False) -> str | JSONResponse:
        """The full address of a page, or the refusal: module off (404), not on the list or AgoraOne's own host for the
        window (422), no URL (409)."""
        on, base = await run_in_threadpool(lookup)
        found = route_of(value)
        module = found[1] if found else default
        if not on[module]:
            return problem(404, texts.off[module], "off")
        if found is None:
            return problem(422, texts.bad_route, "invalid")
        if base is None:
            return problem(409, texts.not_connected, "not_connected")
        if window and agora_host(base):
            return problem(422, texts.loopback_ip, "loopback_ip")
        return page_url(base, found[0])

    def any_on(on: dict[str, bool]) -> bool:
        return any(on[name] for name in users)

    @router.post(f"/{label}/window")
    async def open_window(body: RouteIn):
        url = await target(body.ruta, window=True)
        if isinstance(url, JSONResponse):
            return url
        if not relay.available():
            return problem(409, texts.no_window, "no_window")
        return {"seq": relay.push({"action": "open", "url": url})}

    @router.post(f"/{label}/window/browser")
    async def open_browser(body: RouteIn):
        url = await target(body.ruta)
        if isinstance(url, JSONResponse):
            return url
        if not await run_in_threadpool(open_in_browser, url):
            return problem(502, NO_BROWSER, "error")
        return {"done": True}

    @router.post(f"/{label}/window/external")
    async def open_external(body: UrlIn):
        on, _ = await run_in_threadpool(lookup)
        if not any_on(on):
            return problem(404, texts.off[default], "off")
        url = external_url(body.url)
        if url is None:
            return problem(422, BAD_URL, "invalid")
        if not await run_in_threadpool(open_in_browser, url):
            return problem(502, NO_BROWSER, "error")
        return {"done": True}

    @router.post(f"/{label}/window/close")
    async def close_window():
        """Always allowed (closing hides, never shows): without the desktop app there is nothing to close."""
        return {"done": relay.available() and relay.push({"action": "close"}) > 0}

    @router.post(f"/{label}/window/check")
    async def check_window():
        return {"done": relay.available() and relay.push({"action": "check"}) > 0}

    @router.get(f"/internal/{label}/window/next")  # only the desktop app: the browser cannot reach /internal
    async def window_next(after: int = -1):
        answer = await relay.next(after)
        on, base = await run_in_threadpool(lookup)
        return {**answer, "allowed": any_on(on), "url": base}

    return router
