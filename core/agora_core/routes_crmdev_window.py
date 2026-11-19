"""CRMDev's own web in a window of the desktop app (1.7), for «Abrir en CRMDev» on a project, task, ticket or client
and for all of CRMDev that AgoraOne shows no native view of. The routes are the shared ones of `connector_window.py`
(`/crmdev/window`, `/browser`, `/external`, `/close`, `/check` and `/internal/crmdev/window/next`); this declares its
pages, its module and its sentences. AgoraOne's key for CRMDev's API never goes to the window: the user signs in there
with CRMDev's own login.

The pages are a closed list of CRMDev's Spanish routes (its addresses always carry the language, `/es/...`, and its
proxy turns any other spelling into these), checked in CRMDev's `src/lib/localized-routes.ts` and its pages under
`src/app/[locale]/(dashboard)`: the screen sends the page without the language (`proyectos/{id}`) and the address is
the saved CRMDev URL with `/es/` and the page. An id has CRMDev's shape (letters, digits, `_` and `-`), so nothing
like `../` or another path gets through. With the «CRMDev» module off the routes answer 404 (except `close`, `check`
and `/internal`), and the desktop app closes the window."""

from fastapi import APIRouter

from . import crmdev_api
from .connector_window import WindowTexts, window_router
from .hidden_player import Relay
from .settings import Settings

LOCALE = "es"
PAGES = {"panel", "proyectos", "tareas", "clientes", "soporte"}
ITEMS = {"proyectos": "proyectos", "clientes": "clientes", "tickets": "soporte/tickets"}
# Fixed pages of CRMDev where an id would go (`projects/wordpress`, and «edit»/«details» in both languages): never an id.
RESERVED = frozenset({"wordpress", "editar", "edit", "detalles", "details", "nuevo", "new"})
TEXTS = WindowTexts(
    off={"crmdev": "El módulo CRMDev está apagado."},
    not_connected="Falta la dirección de CRMDev: escríbela en Conectores › CRMDev.",
    bad_route="Esa página de CRMDev no se puede abrir desde AgoraOne.",
    no_window="La ventana de CRMDev solo existe en la app de escritorio: ábrelo en el navegador.",
    loopback_ip=("La ventana de CRMDev no abre 127.0.0.1 ni ::1, que son la dirección de AgoraOne: escribe la de CRMDev con «localhost» "
                 "en Conectores › CRMDev."),
)


def route_of(value: object) -> tuple[str, str] | None:
    """The address path (`es/proyectos/{id}`…) and the module it needs, or None when the page is not on the list.
    The screen names a ticket `tickets/{id}`; in CRMDev it lives under `soporte/tickets/{id}`."""
    if not isinstance(value, str) or len(value) > 100:
        return None
    route = value.strip().strip("/")
    if route in PAGES:
        return f"{LOCALE}/{route}", "crmdev"
    kind, _, item = route.partition("/")
    if kind in ITEMS and crmdev_api.ID.fullmatch(item) and item.lower() not in RESERVED:
        return f"{LOCALE}/{ITEMS[kind]}/{item}", "crmdev"
    return None


def crmdev_window_router(settings: Settings, relay: Relay | None = None) -> APIRouter:
    return window_router(settings, "crmdev", crmdev_api.saved_url, route_of, TEXTS, relay)
