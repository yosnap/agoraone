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

SPEC = web_api.WebApiSpec(
    secret=SECRET, setting=SETTING, key_pattern=r"crm_[0-9a-f]{48}", key_hint="empieza por «crm_» y sigue con 48 letras y números",
    key_source="Ajustes › API Keys de CRMDev (solo propietarios y administradores)", example_url=EXAMPLE_URL, name="CRMDev",
    path_prefix=PATH, scopes=SCOPES, transport=lambda: TRANSPORT)

# The closed list: the only tools AgoraOne ever sends. Nothing that deletes is or will be here.
READ_TOOLS = frozenset({"list_projects", "list_tasks", "list_clients", "list_tickets", "list_members", "get_project_time_report"})
WRITE_TOOLS: frozenset[str] = frozenset()
NOT_ALLOWED = "Herramienta de CRMDev no permitida."
FORBIDDEN = "La clave no vale o tu plan de CRMDev no incluye la API (módulo MCP)."
BUSY = "CRMDev pide esperar unos segundos (demasiadas peticiones seguidas): vuelve a intentarlo en un momento."
ODD = "CRMDev devolvió una respuesta que no se entiende."

ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
PRIORITIES = ("LOW", "MEDIUM", "HIGH", "URGENT")
STATUSES = {
    "list_projects": ("NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"),
    "list_tasks": ("TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"),
    "list_clients": ("LEAD", "PROSPECT", "CUSTOMER", "INACTIVE", "CHURNED"),
    "list_tickets": ("OPEN", "IN_PROGRESS", "WAITING_CLIENT", "RESOLVED", "CLOSED"),
}
CATEGORIES = ("BUG", "FEATURE_REQUEST", "QUESTION", "SUPPORT", "BILLING")


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


ARGUMENTS: dict[str, dict[str, Callable[[object], object]]] = {
    "list_projects": {"limit": _limit, "status": _one_of(STATUSES["list_projects"])},
    "list_tasks": {"limit": _limit, "status": _one_of(STATUSES["list_tasks"]), "projectId": _id, "assigneeId": _id},
    "list_clients": {"limit": _limit, "status": _one_of(STATUSES["list_clients"])},
    "list_tickets": {"limit": _limit, "status": _one_of(STATUSES["list_tickets"]), "priority": _one_of(PRIORITIES),
                     "category": _one_of(CATEGORIES), "clientId": _id},
    "list_members": {"limit": _limit},
    "get_project_time_report": {"projectId": _id},
}
REQUIRED = {"get_project_time_report": ("projectId",)}


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


_cache: dict[tuple, tuple[float, object]] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _cache_key(target: Connection, tool: str, arguments: dict) -> tuple:
    # The key is part of it only as a digest, so another key never reads what this one did.
    return target.url, hashlib.sha256(target.key.encode()).hexdigest(), tool, json.dumps(arguments, sort_keys=True)


def _kept(key: tuple) -> object | None:
    with _cache_lock:
        found = _cache.get(key)
        if found and time.monotonic() - found[0] < CACHE_SECONDS:
            return found[1]
        _cache.pop(key, None)
        return None


def _keep(key: tuple, data: object) -> None:
    with _cache_lock:
        now = time.monotonic()
        for old in [k for k, (at, _) in _cache.items() if now - at >= CACHE_SECONDS]:
            del _cache[old]
        while len(_cache) >= CACHE_ENTRIES:
            del _cache[next(iter(_cache))]
        _cache[key] = (now, data)


def call(target: Connection, tool: str, arguments: dict | None = None) -> object:
    """The only way AgoraOne runs a tool of CRMDev: the tool must be in the closed list and its arguments valid
    before any connection is opened. Answers the `data` CRMDev returns (cached 60 s for reads) or a WebApiError
    without the key; a 429 is `busy` and never retried here."""
    if not isinstance(tool, str) or tool not in READ_TOOLS | WRITE_TOOLS:
        raise WebApiError("error", NOT_ALLOWED)
    arguments = checked_arguments(tool, arguments if arguments is not None else {})
    key = _cache_key(target, tool, arguments)
    if tool in READ_TOOLS and (kept := _kept(key)) is not None:
        return kept
    try:
        answer = web_api.request(SPEC, target, "POST", PATH, body={"tool": tool, "arguments": arguments}, max_bytes=MAX_BYTES)
    except WebApiError as error:
        if error.status == "busy":
            raise WebApiError("busy", BUSY) from None
        raise
    if answer.get("success") is not True or "data" not in answer:
        raise WebApiError("error", ODD)
    data = answer["data"]
    if tool in READ_TOOLS:
        _keep(key, data)
    return data


def probe(target: Connection) -> dict:
    """«Probar»: asks the tool list with a GET (no tool runs) and answers which of the closed list CRMDev offers."""
    try:
        answer = web_api.request(SPEC, target, "GET", PATH, max_bytes=MAX_BYTES)
    except WebApiError as error:
        if error.status == "forbidden":
            raise WebApiError("forbidden", FORBIDDEN) from None
        if error.status == "busy":
            raise WebApiError("busy", BUSY) from None
        raise
    tools = answer.get("tools")
    if answer.get("success") is not True or not isinstance(tools, (dict, list)):
        raise WebApiError("error", ODD)
    allowed = READ_TOOLS | WRITE_TOOLS
    return {"version": None, "scopes": list(SCOPES), "tools": sorted(name for name in tools if isinstance(name, str) and name in allowed)}


# Reduced shapes: only what the views show, text cut, missing fields as None. Lists that go to the screen carry no
# assignee's or guest's address; a client's address only with `contact` (its record, hidden in discreet mode).
TITLE, DESCRIPTION, SHORT = 300, 4000, 120


def _text(value: object, limit: int = SHORT) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:limit] if text else None


def _row_id(value: object) -> str | None:
    return value if isinstance(value, str) and ID.fullmatch(value) else None


def _number(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _name_of(value: object) -> str | None:
    return _text(value.get("name")) if isinstance(value, dict) else None


def shape_project(row: dict) -> dict:
    progress = _number(row.get("progress"))
    return {"id": _row_id(row.get("id")), "name": _text(row.get("name"), TITLE), "status": _text(row.get("status")),
            "progress": progress if progress is not None and 0 <= progress <= 100 else None, "type": _text(row.get("type")),
            "deadline": _text(row.get("deadline"))}


def shape_task(row: dict) -> dict:
    assignee = row.get("assignee") if isinstance(row.get("assignee"), dict) else {}
    return {"id": _row_id(row.get("id")), "title": _text(row.get("title"), TITLE), "description": _text(row.get("description"), DESCRIPTION),
            "status": _text(row.get("status")), "priority": _text(row.get("priority")), "dueDate": _text(row.get("dueDate")),
            "assignee": {"id": _row_id(assignee.get("id")), "name": _text(assignee.get("name"))} if assignee else None,
            "project": _name_of(row.get("project"))}


def shape_client(row: dict, contact: bool = False) -> dict:
    shaped = {"id": _row_id(row.get("id")), "name": _text(row.get("name"), TITLE), "company": _text(row.get("company"), TITLE),
              "status": _text(row.get("status"))}
    return {**shaped, "email": _text(row.get("email"), TITLE)} if contact else shaped


def shape_ticket(row: dict) -> dict:
    return {"id": _row_id(row.get("id")), "title": _text(row.get("title"), TITLE), "description": _text(row.get("description"), DESCRIPTION),
            "status": _text(row.get("status")), "priority": _text(row.get("priority")), "category": _text(row.get("category")),
            "requester": _text(row.get("guestName"), TITLE), "client": _name_of(row.get("client")), "project": _name_of(row.get("project")),
            "createdAt": _text(row.get("createdAt")), "updatedAt": _text(row.get("updatedAt"))}


def shape_member(row: dict) -> dict:
    user = row.get("user") if isinstance(row.get("user"), dict) else {}
    return {"id": _row_id(user.get("id")), "name": _text(user.get("name"), TITLE), "role": _text(row.get("role"))}


def shape_hours(data: object) -> dict:
    data = data if isinstance(data, dict) else {}
    entries = data.get("entries") if isinstance(data.get("entries"), list) else []
    return {"project": _text(data.get("projectName"), TITLE), "total": _text(data.get("totalHours")), "entries": _number(data.get("totalEntries")),
            "rows": [{"task": _text(e.get("task"), TITLE), "user": _text(e.get("user")), "minutes": _number(e.get("minutes"))}
                     for e in entries[:500] if isinstance(e, dict)]}


def shape_list(shape: Callable[[dict], dict], data: object) -> list[dict]:
    if not isinstance(data, list):
        raise WebApiError("error", ODD)
    return [shape(row) for row in data[:MAX_ROWS] if isinstance(row, dict)]
