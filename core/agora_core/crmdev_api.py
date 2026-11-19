"""CRMDev's REST API (`/api/mcp/rest`), reached with a URL and an organization key (`crm_…`) created in CRMDev's
Settings › API Keys. The URL is not secret and lives in `setting`; the key lives only in the system's secret store
under `crmdev-api-key`. The safety of the key (https except on loopback, no redirections, the key only in the
Authorization header and scrubbed from errors, size-capped answers) is the shared one of `web_api.py`.

That key could also delete in CRMDev. AgoraOne never does: every tool goes through `call`, which checks a closed
list (`READ_TOOLS | WRITE_TOOLS`, no `delete_*`) and the arguments of that tool before any connection is opened.
`probe` only asks the tool list with a GET, which runs no tool. What CRMDev answers is data: it is reduced to the
fields the screen shows (no assignee's or guest's address in lists), never read as instructions, and kept only in
an in-memory cache of 60 s, emptied when the connection is saved or forgotten."""

import hashlib
import json
import re
import threading
import time
from collections.abc import Callable

import httpx

from . import web_api
from .web_api import Connection, WebApiError

SECRET = "crmdev-api-key"  # account of the key in the secret store
SETTING = "crmdev.connection"
EXAMPLE_URL = "https://crm.example.com"
PATH = "/api/mcp/rest"
SCOPES = ("organizacion",)
MAX_BYTES = 2 * 1024 * 1024
MAX_ROWS = 100  # CRMDev has no pages: the most recent ones
CACHE_SECONDS = 60
CACHE_ENTRIES = 64
# Tests replace it with an httpx.MockTransport; None is the real network.
TRANSPORT: httpx.BaseTransport | None = None


# The closed list: the only tools AgoraOne ever sends. Nothing that deletes is or will be here.
READ_TOOLS = frozenset({"list_projects", "list_tasks", "list_clients", "list_tickets", "list_members", "get_project_time_report"})
# What AgoraOne may create or change, only from a form the user confirms (crmdev_write); never `delete_*`, never
# `create_project` (CRMDev's own form) nor `create_ticket` (tickets come from clients).
WRITE_TOOLS = frozenset({"create_task", "update_task", "update_project", "create_client", "update_client", "update_ticket"})
# Tools that also need a module of the organization's plan, which only a call reveals.
MODULE_TOOLS = frozenset({"list_tickets", "update_ticket"})
NOT_ALLOWED = "Herramienta de CRMDev no permitida."
FORBIDDEN = "La clave no vale o tu plan de CRMDev no incluye la API (módulo MCP)."
BUSY = "CRMDev pide esperar unos segundos (demasiadas peticiones seguidas): vuelve a intentarlo en un momento."
ODD = "CRMDev devolvió una respuesta que no se entiende."
REVOKED = "CRMDev no acepta la clave: puede estar revocada o caducada. Crea otra en Ajustes › API Keys de CRMDev."
NOT_MEMBER = "Quien creó la clave ya no es miembro de la organización en CRMDev: crea otra clave en Ajustes › API Keys."
NO_PLAN = "Tu plan de CRMDev no incluye la API (módulo MCP)."
TICKETS_OFF = "Los tickets no están activos en tu plan de CRMDev (módulo de soporte)."
TOO_BIG = "CRMDev devolvió una respuesta demasiado grande."  # web_api's own sentence for an answer over the cap
HOURS_TOO_BIG = "El informe de horas de este proyecto es demasiado grande para leerlo aquí: míralo en CRMDev."
DEFAULT_WAIT = 10.0  # seconds, when CRMDev does not say how long

ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
PRIORITIES = ("LOW", "MEDIUM", "HIGH", "URGENT")
STATUSES = {
    "list_projects": ("NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"),
    "list_tasks": ("TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"),
    "list_clients": ("LEAD", "PROSPECT", "CUSTOMER", "INACTIVE", "CHURNED"),
    "list_tickets": ("OPEN", "IN_PROGRESS", "WAITING_CLIENT", "RESOLVED", "CLOSED"),
}
CATEGORIES = ("BUG", "FEATURE_REQUEST", "QUESTION", "SUPPORT", "BILLING", "PERFORMANCE", "SECURITY", "OTHER")


def _limit(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_ROWS:
        raise WebApiError("invalid", f"El límite va de 1 a {MAX_ROWS}.")
    return value


def _id(value: object) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise WebApiError("invalid", "El identificador no es válido.")
    return value


def _one_of(options: tuple[str, ...]) -> Callable[[object], str]:
    def check(value: object) -> str:
        if value not in options:
            raise WebApiError("invalid", "Ese valor no existe en CRMDev.")
        return str(value)
    return check


def _words(limit: int, lines: bool = False, empty: bool = False) -> Callable[[object], object]:
    """A text as crmdev_write leaves it (trimmed, within its limit, no control characters); None only where CRMDev
    empties the field with it. Answered unchanged, so the transport's last check sees the same body."""
    def check(value: object) -> object:
        if value is None and empty:
            return None
        allowed = "\n\t" if lines else ""
        if not isinstance(value, str) or not value or value != value.strip() or len(value) > limit \
                or any((ord(c) < 32 and c not in allowed) or c == "\x7f" for c in value):
            raise WebApiError("invalid", "Un texto para CRMDev no es válido.")
        return value
    return check


def _day(value: object) -> str:
    if not isinstance(value, str) or not DAY.fullmatch(value):
        raise WebApiError("invalid", "La fecha tiene que ser un día AAAA-MM-DD.")
    return value


def _progress(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        raise WebApiError("invalid", "El progreso va de 0 a 100.")
    return value


ARGUMENTS: dict[str, dict[str, Callable[[object], object]]] = {
    "list_projects": {"limit": _limit, "status": _one_of(STATUSES["list_projects"])},
    "list_tasks": {"limit": _limit, "status": _one_of(STATUSES["list_tasks"]), "projectId": _id, "assigneeId": _id},
    "list_clients": {"limit": _limit, "status": _one_of(STATUSES["list_clients"])},
    "list_tickets": {"limit": _limit, "status": _one_of(STATUSES["list_tickets"]), "priority": _one_of(PRIORITIES),
                     "category": _one_of(CATEGORIES), "clientId": _id},
    "list_members": {"limit": _limit},
    "get_project_time_report": {"projectId": _id},
    "create_task": {"title": _words(300), "description": _words(4000, lines=True), "projectId": _id, "assigneeId": _id,
                    "status": _one_of(STATUSES["list_tasks"]), "priority": _one_of(PRIORITIES), "dueDate": _day},
    "update_task": {"taskId": _id, "title": _words(300), "description": _words(4000, lines=True, empty=True),
                    "status": _one_of(STATUSES["list_tasks"]), "priority": _one_of(PRIORITIES)},
    # Never `description`: the list does not give it, so its current value could not be shown.
    "update_project": {"projectId": _id, "name": _words(300), "status": _one_of(STATUSES["list_projects"]), "progress": _progress},
    "create_client": {"name": _words(300), "email": _words(200), "company": _words(300), "phone": _words(40),
                      "status": _one_of(STATUSES["list_clients"])},
    # Never `notes`: the list does not give them and CRMDev would overwrite them whole.
    "update_client": {"clientId": _id, "name": _words(300), "email": _words(200), "company": _words(300, empty=True),
                      "status": _one_of(STATUSES["list_clients"])},
    "update_ticket": {"ticketId": _id, "status": _one_of(STATUSES["list_tickets"]), "priority": _one_of(PRIORITIES),
                      "category": _one_of(CATEGORIES)},
}
REQUIRED = {"get_project_time_report": ("projectId",), "create_task": ("title",), "update_task": ("taskId",),
            "update_project": ("projectId",), "create_client": ("name",), "update_client": ("clientId",), "update_ticket": ("ticketId",)}


def checked_arguments(tool: str, arguments: object) -> dict:
    """The arguments of a tool of the closed list, each checked; an unknown or missing one is refused."""
    if not isinstance(arguments, dict):
        raise WebApiError("invalid", "Argumentos no válidos para CRMDev.")
    rules = ARGUMENTS.get(tool, {})
    if any(name not in rules for name in arguments):
        raise WebApiError("invalid", "Argumento no permitido para esa herramienta de CRMDev.")
    if any(name not in arguments for name in REQUIRED.get(tool, ())):
        raise WebApiError("invalid", "Falta un dato para esa consulta de CRMDev.")
    return {name: rules[name](value) for name, value in arguments.items()}


def _allowed_request(request: httpx.Request) -> bool:
    """The last check before anything leaves with CRMDev's key: only the REST endpoint, a GET without a body (the
    tool list) or a POST of a tool of the closed list with valid arguments."""
    if not request.url.path.endswith(PATH):
        return False
    body = request.read()
    if request.method == "GET":
        return not body
    if request.method != "POST":
        return False
    try:
        sent = json.loads(body)
    except ValueError:
        return False
    if not isinstance(sent, dict) or set(sent) != {"tool", "arguments"}:
        return False
    tool, arguments = sent["tool"], sent["arguments"]
    if not isinstance(tool, str) or tool not in READ_TOOLS | WRITE_TOOLS:
        return False
    try:
        return checked_arguments(tool, arguments) == arguments
    except WebApiError:
        return False


class _Guard(httpx.BaseTransport):
    """Wraps the real transport (or the tests' one) of CRMDev's SPEC: whoever uses the SPEC, a request outside the
    closed list never reaches the network. With a transport of its own, httpx ignores proxies set in the environment."""

    def __init__(self, inner: httpx.BaseTransport):
        self.inner = inner

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if not _allowed_request(request):
            raise WebApiError("error", NOT_ALLOWED)
        return self.inner.handle_request(request)

    def close(self) -> None:
        self.inner.close()


def _guarded() -> httpx.BaseTransport:
    return _Guard(TRANSPORT if TRANSPORT is not None else httpx.HTTPTransport())


SPEC = web_api.WebApiSpec(
    secret=SECRET, setting=SETTING, key_pattern=r"crm_[0-9a-f]{48}", key_hint="empieza por «crm_» y sigue con 48 letras y números",
    key_source="Ajustes › API Keys de CRMDev (solo propietarios y administradores)", example_url=EXAMPLE_URL, name="CRMDev",
    path_prefix=PATH, scopes=SCOPES, transport=_guarded)


_cache: dict[tuple, tuple[float, object, float]] = {}  # key → (when on _clock, data, when on the wall clock)
_flights: dict[tuple, threading.Lock] = {}  # one reading at a time per cache key: the second waits for the first
_busy_until: dict[tuple, float] = {}  # per connection: CRMDev asked to wait until then
_generation = 0  # bumped when the cache is emptied: a reading begun before never fills it afterwards
_cache_lock = threading.Lock()


def _clock() -> float:
    return time.monotonic()


def clear_cache() -> None:
    """Forgets every reading and every «wait» (on saving or forgetting the connection)."""
    global _generation
    with _cache_lock:
        _cache.clear()
        _busy_until.clear()
        _generation += 1


def forget_reads(tools: frozenset[str] | set[str]) -> None:
    """After a change: forgets the readings of those tools (never a «wait» after a 429), and a reading begun before
    never fills the cache afterwards with what CRMDev had before the change."""
    global _generation
    with _cache_lock:
        for key in [k for k in _cache if k[2] in tools]:
            del _cache[key]
        _generation += 1


def _who(target: Connection) -> tuple:
    # The key is part of it only as a digest, so another key never reads what this one did.
    return target.url, hashlib.sha256(target.key.encode()).hexdigest()


def _wall() -> float:
    return time.time()


def _kept(key: tuple) -> tuple[float, object, float] | None:
    with _cache_lock:
        found = _cache.get(key)
        if found and _clock() - found[0] < CACHE_SECONDS:
            return found
        _cache.pop(key, None)
        return None


def _keep(key: tuple, data: object, generation: int, wall: float) -> None:
    with _cache_lock:
        if generation != _generation:
            return
        now = _clock()
        for old in [k for k, entry in _cache.items() if now - entry[0] >= CACHE_SECONDS]:
            del _cache[old]
        while len(_cache) >= CACHE_ENTRIES:
            del _cache[next(iter(_cache))]
        _cache[key] = (now, data, wall)


def _flight(key: tuple) -> threading.Lock:
    with _cache_lock:
        if len(_flights) > 4 * CACHE_ENTRIES:
            for idle in [k for k, lock in _flights.items() if not lock.locked()]:
                del _flights[idle]
        return _flights.setdefault(key, threading.Lock())


def _wait_first(who: tuple) -> None:
    with _cache_lock:
        until = _busy_until.get(who, 0.0)
    if _clock() < until:
        raise WebApiError("busy", BUSY)


def _forbidden(text: str, key: str) -> WebApiError:
    """CRMDev answers 403 for several reasons, told apart by its own `error`."""
    reason = web_api.said(text, key)
    if reason == "Invalid API Key":
        return WebApiError("auth", REVOKED)
    if reason == "MCP_UNAUTHORIZED":
        return WebApiError("auth", NOT_MEMBER)
    if reason == "MODULE_DISABLED":
        return WebApiError("forbidden", TICKETS_OFF)
    if "plan" in reason.lower():
        return WebApiError("forbidden", NO_PLAN)
    return WebApiError("forbidden", FORBIDDEN)


def _retry_after(text: str) -> float:
    try:
        seconds = json.loads(text).get("retryAfter")
    except (ValueError, AttributeError):
        seconds = None
    return float(seconds) if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and 1 <= seconds <= 300 else DEFAULT_WAIT


def _send(target: Connection, method: str, body: dict | None, who: tuple) -> dict:
    """The one exchange with CRMDev (`call` sends a tool by POST, `probe` a GET of the list); the guarded transport
    checks it again before it leaves."""
    with web_api.session(SPEC, web_api.REQUEST_SECONDS) as (client, deadline):
        status, _, raw = web_api.exchange(SPEC, target, method, PATH, None, body, client, deadline, MAX_BYTES, "application/json")
    text = raw.decode("utf-8", errors="replace")
    if status == 403:
        raise _forbidden(text, target.key)
    if status == 429:
        with _cache_lock:
            _busy_until[who] = _clock() + _retry_after(text)
        raise WebApiError("busy", BUSY)
    web_api.refuse(SPEC, status, text, target.key)
    return web_api.json_object(SPEC, text)


def call(target: Connection, tool: str, arguments: dict | None = None, fresh: bool = False) -> object:
    """The only way AgoraOne runs a tool of CRMDev: the tool must be in the closed list and its arguments valid
    before any connection is opened. Answers the `data` CRMDev returns (cached 60 s for reads, one reading at a time
    for the same question) or a WebApiError without the key; a 429 is `busy`, remembered for the time CRMDev says
    and never retried here. `fresh` («Volver a leer») skips the cache, never the wait after a 429."""
    return call_at(target, tool, arguments, fresh)[0]


def call_at(target: Connection, tool: str, arguments: dict | None = None, fresh: bool = False) -> tuple[object, float]:
    """`call`, plus when CRMDev gave that answer (seconds since the epoch): a cached answer keeps its own time, so the
    screen never says «just read» of something read a minute ago."""
    if not isinstance(tool, str) or tool not in READ_TOOLS | WRITE_TOOLS:
        raise WebApiError("error", NOT_ALLOWED)
    arguments = checked_arguments(tool, arguments if arguments is not None else {})
    who = _who(target)
    key = (*who, tool, json.dumps(arguments, sort_keys=True))
    if tool not in READ_TOOLS:
        return _run(target, tool, arguments, who), _wall()
    asked = _clock()
    with _flight(key):
        kept = _kept(key)
        # A fresh reading still takes an answer of the same question that finished while it waited its turn.
        if kept is not None and (not fresh or kept[0] >= asked):
            return kept[1], kept[2]
        generation = _generation
        data = _run(target, tool, arguments, who)
        wall = _wall()
        _keep(key, data, generation, wall)
        return data, wall


def _run(target: Connection, tool: str, arguments: dict, who: tuple) -> object:
    _wait_first(who)
    try:
        answer = _send(target, "POST", {"tool": tool, "arguments": arguments}, who)
    except WebApiError as error:
        if tool == "get_project_time_report" and str(error) == TOO_BIG:
            raise WebApiError("error", HOURS_TOO_BIG) from None
        raise
    if answer.get("success") is not True or "data" not in answer:
        raise WebApiError("error", ODD)
    return answer["data"]


def probe(target: Connection) -> dict:
    """«Probar»: asks the tool list with a GET (no tool runs, and CRMDev does not count it against its limit) and
    answers which of the closed list CRMDev offers. Tools that depend on a module of the plan (tickets) are only
    known when their view is opened: they go in `unverified`, never as available."""
    answer = _send(target, "GET", None, _who(target))
    tools = answer.get("tools")
    if answer.get("success") is not True or not isinstance(tools, (dict, list)):
        raise WebApiError("error", ODD)
    offered = {name for name in tools if isinstance(name, str) and name in READ_TOOLS | WRITE_TOOLS}
    return {"version": None, "scopes": list(SCOPES), "tools": sorted(offered - MODULE_TOOLS), "unverified": sorted(offered & MODULE_TOOLS)}


def connection_of(connection, secrets) -> Connection | None:
    return web_api.connection_of(SPEC, connection, secrets)


def saved_url(connection) -> str | None:
    return web_api.saved_url(SPEC, connection)
