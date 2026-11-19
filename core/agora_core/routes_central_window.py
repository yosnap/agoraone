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
which works without the «Central» one. The routes themselves are the shared ones of `connector_window.py`."""

import webbrowser  # noqa: F401 - the tests patch `webbrowser.open` through this module

from fastapi import APIRouter

from . import central_api, central_views
from .connector_window import BAD_URL, NO_BROWSER, RouteIn, UrlIn, WindowTexts, page_url, window_router
from .hidden_player import Relay
from .settings import Settings
from .window_links import agora_host, external_url, open_in_browser

__all__ = ["BAD_URL", "NO_BROWSER", "RouteIn", "UrlIn", "agora_host", "central_window_router", "external_url", "open_in_browser", "page_url",
           "route_of"]

PAGES = {"", "ajustes", "webs", "servidores", "alertas", "correo"}
ITEMS = {"clientes", "proyectos", "servidores", "presupuestos"}
OFF = "El módulo Central está apagado."
OFF_QUOTES = "El módulo Presupuestos está apagado."
NOT_CONNECTED = "Falta la dirección de Central: escríbela en Conectores › Central."
BAD_ROUTE = "Esa página de Central no se puede abrir desde AgoraOne."
NO_WINDOW = "La ventana de Central solo existe en la app de escritorio: ábrelo en el navegador."
LOOPBACK_IP = ("La ventana de Central no abre 127.0.0.1 ni ::1, que son la dirección de AgoraOne: escribe la de Central con «localhost» "
               "(por ejemplo http://localhost:3099) en Conectores › Central.")


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


def central_window_router(settings: Settings, relay: Relay | None = None) -> APIRouter:
    """Central's window routes, built by the shared connector window factory: a quote's page follows «Presupuestos»."""
    texts = WindowTexts(off={"central": OFF, "presupuestos": OFF_QUOTES}, not_connected=NOT_CONNECTED, bad_route=BAD_ROUTE,
                        no_window=NO_WINDOW, loopback_ip=LOOPBACK_IP)
    return window_router(settings, "central", central_api.saved_url, route_of, texts, relay)
