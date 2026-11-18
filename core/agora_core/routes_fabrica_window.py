"""Mi fábrica's own panel in a window of the desktop app (1.7): the panel as it is, with its own password and session,
to approve or reject runs, watch competitors, keep ideas and change its settings. AgoraOne brings none of its code and
nothing of the panel goes through AgoraOne's API.

`POST /fabrica/window` (`{ruta}`) leaves an order for the desktop app, which collects it at
`GET /internal/fabrica/window/next` like Central's window (the browser cannot reach `/internal`). The page comes from
a closed list and the address is always `http://127.0.0.1:{port}`, with the port of the fábrica's folder registered
in Conectores (the panel listens on IPv4 only, so `localhost` could reach another program on `::1`). Without the
desktop app the answer is 409 and `POST /fabrica/window/browser` opens the same page in the system's browser. A link
of the panel to another site is told by the desktop app to AgoraOne's window, and `POST /fabrica/window/external`
(`{url}`) opens it in the system's browser. `POST /fabrica/window/close` closes the window (discreet mode) and
`POST /fabrica/window/check` makes the desktop app look again at once; each answer of `/internal/.../next` says
whether the window may stay (`allowed`: the module on) and the panel's address (`url`, null without a folder).

`POST /fabrica/start` asks macOS to start the fábrica's own service (`fabrica_service`), never stops or changes it.

With the «Mi fábrica» module off every route answers 404, except closing and `/internal`."""

from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import addons, fabrica_service, modules
from .db import DB_NAME, connect
from .hidden_player import Relay
from .routes_central_window import RouteIn, UrlIn
from .settings import Settings
from .window_links import external_url, open_in_browser

PAGES = {"", "corridas", "publicaciones", "competidores", "piezas", "ideas", "senales", "ajustes"}
# AgoraOne's server on this machine; the core's own port comes from its settings.
SERVER_PORT = 4317
OFF = "El módulo Mi fábrica está apagado."
NOT_CONFIGURED = "Indica la carpeta de mi fábrica en Conectores."
OWN_PORT = "El puerto de la fábrica es uno de los de AgoraOne: cámbialo en Conectores."
BAD_ROUTE = "Esa página de la fábrica no se puede abrir desde AgoraOne."
NO_WINDOW = "La ventana de la fábrica solo existe en la app de escritorio: ábrela en el navegador."
BAD_URL = "Solo se abren en el navegador direcciones web (http o https)."
NO_BROWSER = "No se pudo abrir el navegador."


def route_of(value: object) -> str | None:
    """The page of the panel (`corridas`, `ajustes`…, `""` for its start), or None when it is not on the list."""
    if not isinstance(value, str) or len(value) > 40:
        return None
    route = value.strip().strip("/")
    return route if route in PAGES else None


def panel_base(connection, own_ports: set[int]) -> tuple[str | None, str]:
    """The panel's address and, when there is none, why: `not_configured` (no folder, or not the fábrica's) or
    `own_port` (a port of AgoraOne)."""
    config = addons.config(connection, "fabrica")
    path, port = config.get("path"), config.get("port")
    if not isinstance(path, str) or not addons.recognised("fabrica", Path(path)):
        return None, "not_configured"
    if type(port) is not int or not 1024 <= port <= 65535:
        return None, "not_configured"
    if port in own_ports:
        return None, "own_port"
    return f"http://127.0.0.1:{port}", ""


def fabrica_window_router(settings: Settings, relay: Relay | None = None) -> APIRouter:
    router = APIRouter()
    relay = relay or Relay()
    own_ports = {SERVER_PORT, settings.port}

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    def problem(status: int, message: str, kind: str) -> JSONResponse:
        return JSONResponse({"error": message, "status": kind}, status_code=status)

    def lookup() -> tuple[bool, str | None, str, dict]:
        with database() as connection:
            base, why = panel_base(connection, own_ports)
            return modules.state(connection)["fabrica"], base, why, addons.config(connection, "fabrica")

    async def base_or_problem() -> tuple[str, dict] | JSONResponse:
        on, base, why, config = await run_in_threadpool(lookup)
        if not on:
            return problem(404, OFF, "off")
        if base is None:
            return problem(409, OWN_PORT if why == "own_port" else NOT_CONFIGURED, why)
        return base, config

    async def target(value: object) -> str | JSONResponse:
        """The full address of a page of the panel, or the refusal: module off (404), not on the list (422), no
        folder or a port of AgoraOne (409)."""
        found = await base_or_problem()
        if isinstance(found, JSONResponse):
            return found
        route = route_of(value)
        if route is None:
            return problem(422, BAD_ROUTE, "invalid")
        return f"{found[0]}/{route}"

    @router.post("/fabrica/window")
    async def open_window(body: RouteIn):
        url = await target(body.ruta)
        if isinstance(url, JSONResponse):
            return url
        if not relay.available():
            return problem(409, NO_WINDOW, "no_window")
        return {"seq": relay.push({"action": "open", "url": url})}

    @router.post("/fabrica/window/browser")
    async def open_browser(body: RouteIn):
        url = await target(body.ruta)
        if isinstance(url, JSONResponse):
            return url
        if not await run_in_threadpool(open_in_browser, url):
            return problem(502, NO_BROWSER, "error")
        return {"done": True}

    @router.post("/fabrica/window/external")
    async def open_external(body: UrlIn):
        on, *_ = await run_in_threadpool(lookup)
        if not on:
            return problem(404, OFF, "off")
        url = external_url(body.url)
        if url is None:
            return problem(422, BAD_URL, "invalid")
        if not await run_in_threadpool(open_in_browser, url):
            return problem(502, NO_BROWSER, "error")
        return {"done": True}

    @router.post("/fabrica/window/close")
    async def close_window():
        """Always allowed (closing hides, never shows): without the desktop app there is nothing to close."""
        return {"done": relay.available() and relay.push({"action": "close"}) > 0}

    @router.post("/fabrica/window/check")
    async def check_window():
        on, *_ = await run_in_threadpool(lookup)
        if not on:
            return problem(404, OFF, "off")
        return {"done": relay.available() and relay.push({"action": "check"}) > 0}

    @router.post("/fabrica/start")
    async def start():
        """Starts the fábrica's service when its panel does not answer; `running` when it already did."""
        found = await base_or_problem()
        if isinstance(found, JSONResponse):
            return found
        if await run_in_threadpool(addons.status, "fabrica", found[1]) == "responding":
            return {"done": True, "running": True}
        try:
            await run_in_threadpool(fabrica_service.start)
        except fabrica_service.StartError as error:
            return problem(502 if error.kind == "error" else 409, str(error), error.kind)
        return {"done": True, "running": False}

    @router.get("/internal/fabrica/window/next")  # only the desktop app: the browser cannot reach /internal
    async def window_next(after: int = -1):
        answer = await relay.next(after)
        on, base, *_ = await run_in_threadpool(lookup)
        return {**answer, "allowed": on, "url": base}

    return router
