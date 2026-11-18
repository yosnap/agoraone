"""Central's own web in a window of the desktop app (1.7), for what has no native view in AgoraOne (Central's
settings, secrets, scanner, videos, integrations, its mail) and for «Abrir en Central» on a client, project or quote.
Never in a frame: the window loads Central as its main page, with its own session store, and the user signs in to
Central with Central's own login; AgoraOne's key for Central's API never goes there.

`POST /central/window` (`{ruta}`) leaves an order for the desktop app, which collects it at
`GET /internal/central/window/next` like the hidden YouTube window (the browser cannot reach `/internal`). The route
comes from a closed list and an id must look like a cuid, so the screen can only open Central's own pages; the
address is the saved URL of Central. Without the desktop app (AgoraOne in a browser tab) the answer is 409 and
`POST /central/window/browser` opens the same page in the system's browser instead. A link of Central to another site
is never followed inside the window: the desktop app tells AgoraOne's window, which offers it, and
`POST /central/window/external` (`{url}`, http or https; the screen warns first when it is not encrypted) opens it in
the system's browser. `POST /central/window/close` closes the window (discreet mode turned on) and
`POST /central/window/check` makes the desktop app look again at once; each answer of `/internal/.../next` says
whether the window may stay (`allowed`: a module that uses it is on) and Central's saved address (`url`): with the
module off, the address removed or changed, the desktop app closes it.

A Central on 127.0.0.1 or ::1 is never opened in the window (422 `loopback_ip`, write `localhost` instead): that is
AgoraOne's own host, and cookies go by host, not by port, so on a Mac without a store of its own for the window
AgoraOne's access cookie would reach that Central. The browser can still open it.

With the «Central» module off every route answers 404; a quote's page follows the «Presupuestos» module instead,
which works without the «Central» one."""

import ipaddress
import re
import webbrowser
from contextlib import contextmanager
from urllib.parse import urlsplit

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import central_api, central_views, modules
from .db import DB_NAME, connect
from .hidden_player import Relay
from .settings import Settings

PAGES = {"", "ajustes", "webs", "servidores", "correo"}
ITEMS = {"clientes", "proyectos", "presupuestos"}
MAX_URL = 2000
OFF = "El módulo Central está apagado."
OFF_QUOTES = "El módulo Presupuestos está apagado."
NOT_CONNECTED = "Falta la dirección de Central: escríbela en Ajustes › Central."
BAD_ROUTE = "Esa página de Central no se puede abrir desde AgoraOne."
NO_WINDOW = "La ventana de Central solo existe en la app de escritorio: ábrelo en el navegador."
BAD_URL = "Solo se abren en el navegador direcciones web (http o https)."
LOOPBACK_IP = ("La ventana de Central no abre 127.0.0.1 ni ::1, que son la dirección de AgoraOne: escribe la de Central con «localhost» "
               "(por ejemplo http://localhost:3099) en Ajustes › Central.")
NO_BROWSER = "No se pudo abrir el navegador."
_HOST = re.compile(r"[a-z0-9.-]{1,253}|[0-9a-f:.]{2,45}")


class RouteIn(BaseModel):
    ruta: object = None


class UrlIn(BaseModel):
    url: object = None


def route_of(value: object) -> tuple[str, str] | None:
    """The page (`ajustes`, `clientes/{cuid}`…) and the module it needs, or None when it is not on the list."""
    if not isinstance(value, str) or len(value) > 80:
        return None
    route = value.strip().strip("/")
    if route in PAGES:
        return route, "central"
    kind, _, item = route.partition("/")
    if kind in ITEMS and central_views.ID.fullmatch(item):
        return route, "presupuestos" if kind == "presupuestos" else "central"
    return None


def external_url(value: object) -> str | None:
    """A web address (http or https) with a host and no user or password, printable ASCII (WebKit hands them
    percent-encoded)."""
    if not isinstance(value, str) or not 8 < len(value) <= MAX_URL or not all(c.isascii() and c.isprintable() and not c.isspace() for c in value):
        return None
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        parts.port  # noqa: B018 - raises on a port that is not a number
    except ValueError:
        return None
    if parts.scheme not in ("https", "http") or parts.username is not None or parts.password is not None or not _HOST.fullmatch(host):
        return None
    return value


def agora_host(url: str) -> bool:
    """127.x or ::1: AgoraOne's own host, which shares its cookies whatever the port."""
    try:
        return ipaddress.ip_address(urlsplit(url).hostname or "").is_loopback
    except ValueError:
        return False


def page_url(base: str, route: str) -> str:
    return f"{base}/{route}" if route else f"{base}/"


def open_in_browser(url: str) -> bool:
    """The system's browser (Safari, Edge, Firefox…) on macOS, Windows and Linux; never through a shell."""
    try:
        return bool(webbrowser.open(url, new=2))
    except webbrowser.Error:
        return False


def central_window_router(settings: Settings, relay: Relay | None = None) -> APIRouter:
    router = APIRouter()
    relay = relay or Relay()

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
            return modules.state(connection), central_api.saved_url(connection)

    async def target(value: object, window: bool = False) -> str | JSONResponse:
        """The full address of a page of Central, or the refusal: module off (404), not on the list or AgoraOne's own
        host for the window (422), no URL (409)."""
        on, base = await run_in_threadpool(lookup)
        found = route_of(value)
        module = found[1] if found else "central"
        if not on[module]:
            return problem(404, OFF if module == "central" else OFF_QUOTES, "off")
        if found is None:
            return problem(422, BAD_ROUTE, "invalid")
        if base is None:
            return problem(409, NOT_CONNECTED, "not_connected")
        if window and agora_host(base):
            return problem(422, LOOPBACK_IP, "loopback_ip")
        return page_url(base, found[0])

    async def any_module_on() -> bool:
        on, _ = await run_in_threadpool(lookup)
        return on["central"] or on["presupuestos"]

    @router.post("/central/window")
    async def open_window(body: RouteIn):
        url = await target(body.ruta, window=True)
        if isinstance(url, JSONResponse):
            return url
        if not relay.available():
            return problem(409, NO_WINDOW, "no_window")
        return {"seq": relay.push({"action": "open", "url": url})}

    @router.post("/central/window/browser")
    async def open_browser(body: RouteIn):
        url = await target(body.ruta)
        if isinstance(url, JSONResponse):
            return url
        if not await run_in_threadpool(open_in_browser, url):
            return problem(502, NO_BROWSER, "error")
        return {"done": True}

    @router.post("/central/window/external")
    async def open_external(body: UrlIn):
        if not await any_module_on():
            return problem(404, OFF, "off")
        url = external_url(body.url)
        if url is None:
            return problem(422, BAD_URL, "invalid")
        if not await run_in_threadpool(open_in_browser, url):
            return problem(502, NO_BROWSER, "error")
        return {"done": True}

    @router.post("/central/window/close")
    async def close_window():
        """Always allowed (closing hides, never shows): without the desktop app there is nothing to close."""
        return {"done": relay.available() and relay.push({"action": "close"}) > 0}

    @router.post("/central/window/check")
    async def check_window():
        return {"done": relay.available() and relay.push({"action": "check"}) > 0}

    @router.get("/internal/central/window/next")  # only the desktop app: the browser cannot reach /internal
    async def window_next(after: int = -1):
        answer = await relay.next(after)
        on, base = await run_in_threadpool(lookup)
        return {**answer, "allowed": on["central"] or on["presupuestos"], "url": base}

    return router
