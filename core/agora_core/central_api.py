"""Central's HTTP API (`/api/v1/*`), reached with a URL and an access key created in Central's Settings › «Apps
conectadas». The URL is not secret and lives in `setting`; the key lives only in the system's secret store
(Keychain, Windows Credential Manager or Secret Service) under `central-api-key`.

The safety of the key (https except on loopback, no redirections, the key only in the Authorization header and
scrubbed from errors, size-capped answers) is the shared one of `web_api.py`; this module names Central's own
`SPEC` and keeps its public names, plus what only Central has: its writes, documents, status and snapshot."""

import re
from contextlib import contextmanager

import httpx

from . import web_api
from .web_api import Connection, WebApiError

SECRET = "central-api-key"  # account of the key in the secret store
SETTING = "central.connection"
EXAMPLE_URL = "https://central.example.com"
SCOPES = ("lectura", "presupuestos", "escritura")
TIMEOUT = web_api.TIMEOUT
REQUEST_SECONDS = web_api.REQUEST_SECONDS  # a whole request, however slowly Central drips its answer
TOTAL_SECONDS = 180  # a whole reading of the snapshot
MAX_BYTES = web_api.MAX_BYTES
NO_STORE = web_api.NO_STORE
# Tests replace it with an httpx.MockTransport; None is the real network.
TRANSPORT: httpx.BaseTransport | None = None

SPEC = web_api.WebApiSpec(
    secret=SECRET, setting=SETTING, key_pattern=r"cen_[A-Za-z0-9_-]{43}", key_hint="empieza por «cen_»",
    key_source="Ajustes › Apps conectadas de Central", example_url=EXAMPLE_URL, name="Central", path_prefix="/api/v1/",
    scopes=SCOPES, rate_limited="unreachable", transport=lambda: TRANSPORT)

CentralApiError = WebApiError


def url_problem(value: object) -> str | None:
    return web_api.url_problem(SPEC, value)


def normalize_url(value: object) -> str:
    """The base URL of Central (scheme, host, port and an optional path, without a trailing «/»)."""
    return web_api.normalize_url(SPEC, value)


def origin(url: str) -> tuple[str, str, int]:
    return web_api.origin(SPEC, url)


def same_origin(a: str | None, b: str | None) -> bool:
    return web_api.same_origin(SPEC, a, b)


def key_problem(key: object) -> str | None:
    return web_api.key_problem(SPEC, key)


def saved_url(connection) -> str | None:
    return web_api.saved_url(SPEC, connection)


def save_url(connection, url: str | None) -> None:
    web_api.save_url(SPEC, connection, url)


def read_key(secrets) -> str | None:
    return web_api.read_key(SPEC, secrets)


def write_key(secrets, key: str | None) -> None:
    web_api.write_key(SPEC, secrets, key)


def connection_of(connection, secrets) -> Connection | None:
    return web_api.connection_of(SPEC, connection, secrets)


def _said(answer_text: str, key: str) -> str:
    return web_api.said(answer_text, key)


@contextmanager
def session(seconds: float = TOTAL_SECONDS):
    """One connection to Central for several requests, with a deadline for all of them."""
    with web_api.session(SPEC, seconds) as opened:
        yield opened


def _exchange(target: Connection, method: str, path: str, params: dict | None, body: dict | None, client: httpx.Client,
              deadline: float | None, max_bytes: int, accept: str) -> tuple[int, str, bytes]:
    return web_api.exchange(SPEC, target, method, path, params, body, client, deadline, max_bytes, accept, REQUEST_SECONDS)


def _refuse(status: int, text: str, key: str) -> None:
    web_api.refuse(SPEC, status, text, key)


def _object(text: str) -> dict:
    return web_api.json_object(SPEC, text)


def request(target: Connection, method: str, path: str, params: dict | None = None, body: dict | None = None,
            client: httpx.Client | None = None, deadline: float | None = None) -> dict:
    """One call to Central's API; the JSON object it answers or a CentralApiError without the key. With `client`
    (from `session`) the connection is reused and `deadline` bounds the whole reading."""
    if client is None:
        with session(REQUEST_SECONDS) as (own, own_deadline):
            return request(target, method, path, params, body, own, own_deadline)
    return web_api.request(SPEC, target, method, path, params, body, client, deadline, MAX_BYTES, REQUEST_SECONDS)


CONFLICTS = ("conflict", "duplicate", "status_locked")
BUSY = "Central está ocupada con otro cambio: no se ha cambiado nada. Vuelve a pulsar «Guardar en Central» en unos segundos."


class CentralConflict(CentralApiError):
    """A 409 of a write: `kind` is `conflict` (someone changed it since it was read), `duplicate` (a client's name
    already taken) or `status_locked`; `current` is the entity as Central has it now, when it says so. Nothing changed."""

    def __init__(self, kind: str, message: str, current: dict | None):
        super().__init__("conflict", message)
        self.kind = kind
        self.current = current


def write(target: Connection, method: str, path: str, body: dict, client: httpx.Client | None = None,
          deadline: float | None = None) -> dict:
    """One write of Central's API (`POST` or `PATCH`, never anything that deletes): the JSON object it answers, a
    CentralConflict on 409 with what Central has now, or a CentralApiError without the key. Never repeated here:
    a 503 (Central busy, nothing written) is said so the user may press again."""
    if method not in ("POST", "PATCH"):
        raise CentralApiError("error", "Método no permitido.")
    if client is None:
        with session(REQUEST_SECONDS) as (own, own_deadline):
            return write(target, method, path, body, own, own_deadline)
    status, _, raw = _exchange(target, method, path, None, body, client, deadline, MAX_BYTES, "application/json")
    text = raw.decode("utf-8", errors="replace")
    if status == 409:
        try:
            data = _object(text)
        except CentralApiError:
            data = None
        data = data if isinstance(data, dict) else {}
        kind = data.get("error") if data.get("error") in CONFLICTS else "conflict"
        current = data.get("current") if isinstance(data.get("current"), dict) else None
        raise CentralConflict(kind, _said(text, target.key) or "Ha cambiado en Central desde que lo leíste.", current)
    if status == 503:
        raise CentralApiError("busy", BUSY)
    if status == 404:
        raise CentralApiError("not_found", "Eso ya no está en Central.")
    if status == 422:
        said = _said(text, target.key)
        raise CentralApiError("invalid", f"Central no aceptó el cambio{': ' + said if said else ''}.")
    _refuse(status, text, target.key)
    return _object(text)


def download(target: Connection, path: str, content_type: str, max_bytes: int, client: httpx.Client | None = None,
             deadline: float | None = None) -> bytes:
    """A file of Central's API (a quote's PDF or Word): only with the expected content type and at most `max_bytes`;
    whatever else Central answers is an error in plain words. Never a redirection, never the key in a message."""
    if client is None:
        with session(REQUEST_SECONDS) as (own, own_deadline):
            return download(target, path, content_type, max_bytes, own, own_deadline)
    status, given, raw = _exchange(target, "GET", path, None, None, client, deadline, max_bytes, content_type)
    if not 200 <= status < 300:
        _refuse(status, raw[:4096].decode("utf-8", errors="replace"), target.key)
    if given.split(";", 1)[0].strip().lower() != content_type:
        raise CentralApiError("error", "Central devolvió un documento de otro tipo.")
    if not raw:
        raise CentralApiError("error", "Central devolvió un documento vacío.")
    return raw


def status(target: Connection, client: httpx.Client | None = None, deadline: float | None = None) -> dict:
    """`GET /api/v1/estado`: Central's version and the permissions of the key."""
    data = request(target, "GET", "/api/v1/estado", client=client, deadline=deadline)
    scopes = [s for s in data.get("scopes") or [] if s in SCOPES] if isinstance(data.get("scopes"), list) else []
    version = data.get("version")
    runtime = data.get("runtime")
    return {"version": str(version)[:40] if version is not None else None, "api": str(data.get("api") or "")[:10] or None,
            "scopes": scopes, "runtime": runtime if runtime in ("production", "local") else None}


def _rows(data: dict, name: str) -> list[dict]:
    value = data.get(name)
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


PROJECT_PAGES = 25  # 200 projects a page: up to 5000, far more than anyone has


NO_READING = "La clave de Central no tiene el permiso «lectura»: no se leen clientes ni servidores."


class NoReadingError(CentralApiError):
    """The key works but cannot read (only «presupuestos», say): a setting, not a failure."""

    def __init__(self):
        super().__init__("forbidden", NO_READING)


def read_all(target: Connection, seconds: float = TOTAL_SECONDS) -> dict:
    """What the snapshot needs, in the same shape as the stdio reading: clients, projects, websites, servers and
    each client's contact. Needs the `lectura` permission; one connection and one deadline for the whole reading."""
    with session(seconds) as (client, deadline):
        def get(path: str, params: dict | None = None) -> dict:
            return request(target, "GET", path, params, client=client, deadline=deadline)
        if "lectura" not in status(target, client, deadline)["scopes"]:
            raise NoReadingError()
        clients = _rows(get("/api/v1/clientes"), "clients")
        projects: list[dict] = []
        cursor = None
        for _ in range(PROJECT_PAGES):
            page = get("/api/v1/proyectos", {"limite": 200, **({"cursor": cursor} if cursor else {})})
            projects += _rows(page, "projects")
            cursor = page.get("nextCursor")
            if not isinstance(cursor, str) or not cursor:
                break
        websites = _rows(get("/api/v1/webs"), "websites")
        servers = _rows(get("/api/v1/servidores"), "servers")
    details = {c["name"]: {k: c.get(k) for k in ("company", "email", "phone", "taxId")} for c in clients if isinstance(c.get("name"), str)}
    return {"clients": clients, "projects": projects, "websites": websites, "servers": servers, "details": details}


def create_quote(target: Connection, quote: dict) -> dict:
    """`POST /api/v1/presupuestos`: a draft with the next number of the year. Needs the `presupuestos` permission.
    Then reads it back for the client's name as Central has it (left out if that reading fails)."""
    with session(REQUEST_SECONDS * 2) as (client, deadline):
        data = request(target, "POST", "/api/v1/presupuestos", body=quote, client=client, deadline=deadline)
        made = {"id": data.get("id"), "number": data.get("number")}
        if isinstance(made["id"], str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", made["id"]):
            try:
                full = request(target, "GET", f"/api/v1/presupuestos/{made['id']}", client=client, deadline=deadline)
            except CentralApiError:
                return made
            name = full.get("client", {}).get("name") if isinstance(full.get("client"), dict) else None
            if isinstance(name, str) and name:
                made["client"] = name[:200]
    return made
