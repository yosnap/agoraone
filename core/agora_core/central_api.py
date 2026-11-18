"""Central's HTTP API (`/api/v1/*`), reached with a URL and an access key created in Central's Settings › «Apps
conectadas». The URL is not secret and lives in `setting`; the key lives only in the system's secret store
(Keychain, Windows Credential Manager or Secret Service) under `central-api-key`.

Safety of the key: https is required except on loopback (`localhost`, `127.0.0.1`, `::1`); redirections are never
followed, so a 30x can never carry the key to another host; the key goes only in the Authorization header and is
scrubbed from any text of Central that ends up in an error; answers are size-capped. Errors say what happened in
plain words and never include the key, the request headers or the raw answer."""

import json
import re
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from .db import transaction

SECRET = "central-api-key"  # account of the key in the secret store
SETTING = "central.connection"
SUGGESTED_URL = "https://central.example.com"
SCOPES = ("lectura", "presupuestos", "escritura")
TIMEOUT = httpx.Timeout(15, connect=5)  # per operation (connect, each read)
REQUEST_SECONDS = 60  # a whole request, however slowly Central drips its answer
TOTAL_SECONDS = 180  # a whole reading of the snapshot, like the stdio way
MAX_BYTES = 8 * 1024 * 1024
_KEY = re.compile(r"cen_[A-Za-z0-9_-]{43}")
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}
# Tests replace it with an httpx.MockTransport; None is the real network.
TRANSPORT: httpx.BaseTransport | None = None
NO_STORE = "No hay un almacén de secretos activo (Secret Service, Llavero o Administrador de credenciales): sin él no se guarda la clave."


class CentralApiError(RuntimeError):
    """`status`: 'config' (URL or key not valid), 'auth' (key refused), 'forbidden' (key without that permission),
    'not_found', 'invalid' (Central refused the data), 'unreachable' or 'error'."""

    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


def url_problem(value: object) -> str | None:
    try:
        normalize_url(value)
    except CentralApiError as error:
        return str(error)
    return None


def normalize_url(value: object) -> str:
    """The base URL of Central (scheme, host, port and an optional path, without a trailing «/»)."""
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 300:
        raise CentralApiError("config", "Escribe la dirección de Central, por ejemplo https://central.example.com.")
    try:
        parts = urlsplit(value.strip())
        host = (parts.hostname or "").lower()
        port = parts.port  # raises on a port that is not a number or out of range
    except ValueError:
        raise CentralApiError("config", "La dirección de Central no es válida.") from None
    if port is not None and not 1 <= port <= 65535:
        raise CentralApiError("config", "La dirección de Central no es válida: el puerto va de 1 a 65535.")
    if host and ":" not in host and not _valid_host(host):
        raise CentralApiError("config", "La dirección de Central no es válida: revisa el nombre del servidor.")
    if parts.scheme not in ("https", "http") or not host or parts.username or parts.password or parts.query or parts.fragment:
        raise CentralApiError("config", "La dirección de Central no es válida: solo https://servidor (sin usuario, ? ni #).")
    if parts.scheme == "http" and host not in _LOOPBACK:
        raise CentralApiError("config", "Fuera de este equipo, Central solo se conecta por https: la clave nunca viaja sin cifrar.")
    if not all(c.isascii() and c.isprintable() and not c.isspace() for c in value.strip()):
        raise CentralApiError("config", "La dirección de Central no es válida.")
    netloc = parts.netloc.rsplit("@", 1)[-1]
    return f"{parts.scheme}://{netloc}{parts.path.rstrip('/')}"


_LABEL = re.compile(r"(?!-)[a-z0-9-]{1,63}(?<!-)")


def _valid_host(host: str) -> bool:
    """A host name made of valid labels (international names through idna), never empty labels like «a..b»."""
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return False
    return len(ascii_host) <= 253 and all(_LABEL.fullmatch(label) for label in ascii_host.split("."))


def origin(url: str) -> tuple[str, str, int]:
    """Scheme, host and port of a valid URL: a key saved for one origin never travels to another one unasked."""
    parts = urlsplit(normalize_url(url))
    return parts.scheme, (parts.hostname or "").lower(), parts.port or (443 if parts.scheme == "https" else 80)


def same_origin(a: str | None, b: str | None) -> bool:
    try:
        return bool(a and b) and origin(a) == origin(b)
    except CentralApiError:
        return False


def key_problem(key: object) -> str | None:
    if not isinstance(key, str):
        return "La clave de Central debe ser texto."
    if not _KEY.fullmatch(key.strip()):
        return "La clave de Central no parece válida: empieza por «cen_»; cópiala entera desde Ajustes › Apps conectadas de Central."
    return None


def saved_url(connection: sqlite3.Connection) -> str | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    if not row:
        return None
    try:
        url = json.loads(row["value"]).get("url")
    except (ValueError, AttributeError):
        return None
    return url if isinstance(url, str) and url_problem(url) is None else None


def save_url(connection: sqlite3.Connection, url: str | None) -> None:
    with transaction(connection):
        if url is None:
            connection.execute("DELETE FROM setting WHERE key = ?", (SETTING,))
        else:
            connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                               (SETTING, json.dumps({"url": normalize_url(url)})))


def read_key(secrets) -> str | None:
    """The key from the secret store; a store that does not work is said plainly (never stored in plain text)."""
    try:
        key = secrets.get(SECRET)
    except Exception:  # noqa: BLE001 - keyring raises its own kinds per system; none of them carries the key
        raise CentralApiError("config", NO_STORE) from None
    return key if isinstance(key, str) and key else None


def write_key(secrets, key: str | None) -> None:
    try:
        secrets.put(SECRET, key)
    except Exception:  # noqa: BLE001 - as in read_key
        raise CentralApiError("config", NO_STORE) from None


@dataclass(frozen=True)
class Connection:
    """URL and key of a Central reached over HTTP. `repr` never shows the key."""
    url: str
    key: str

    def __repr__(self) -> str:
        return f"Connection(url={self.url!r})"


def connection_of(connection: sqlite3.Connection, secrets) -> Connection | None:
    """The saved connection when there are both a URL and a key; None otherwise (or with no working store)."""
    url = saved_url(connection)
    if not url:
        return None
    try:
        key = read_key(secrets)
    except CentralApiError:
        return None
    return Connection(url, key) if key else None


def _said(answer_text: str, key: str) -> str:
    """Central's own short reason (`detail` or `error`), without the key should it ever echo it."""
    try:
        data = json.loads(answer_text)
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    reason = data.get("detail") or data.get("error") or ""
    text = " ".join(str(reason).split())[:200]
    return text.replace(key, "***") if key else text


@contextmanager
def session(seconds: float = TOTAL_SECONDS):
    """One connection to Central for several requests, with a deadline for all of them."""
    with httpx.Client(transport=TRANSPORT, timeout=TIMEOUT, follow_redirects=False) as client:
        yield client, time.monotonic() + seconds


def _exchange(target: Connection, method: str, path: str, params: dict | None, body: dict | None, client: httpx.Client,
              deadline: float | None, max_bytes: int, accept: str) -> tuple[int, str, bytes]:
    """One call: status, content type and the bytes of the answer (at most `max_bytes`), or a CentralApiError."""
    if not path.startswith("/api/v1/"):
        raise CentralApiError("error", "Ruta de Central no permitida.")
    url = normalize_url(target.url)
    headers = {"Authorization": f"Bearer {target.key}", "Accept": accept, "User-Agent": "AgoraOne"}
    until = min(deadline or float("inf"), time.monotonic() + REQUEST_SECONDS)
    late = CentralApiError("unreachable", "Central no respondió a tiempo.")
    too_big = CentralApiError("error", "Central devolvió una respuesta demasiado grande.")
    if time.monotonic() >= until:
        raise late
    try:
        with client.stream(method, f"{url}{path}", params=params, json=body, headers=headers) as answer:
            declared = answer.headers.get("content-length") or "0"
            if not (declared.isascii() and declared.isdigit()) or int(declared) > max_bytes:
                raise too_big
            chunks, read = [], 0
            for chunk in answer.iter_bytes():
                read += len(chunk)
                if read > max_bytes:
                    raise too_big
                if time.monotonic() > until:
                    raise late
                chunks.append(chunk)
            return answer.status_code, answer.headers.get("content-type") or "", b"".join(chunks)
    except CentralApiError:
        raise
    except httpx.TimeoutException:
        raise late from None
    except (httpx.InvalidURL, UnicodeError, ValueError):
        raise CentralApiError("config", "La dirección de Central no es válida.") from None
    except httpx.HTTPError:
        raise CentralApiError("unreachable", "No se pudo conectar con Central: comprueba la dirección y que esté en marcha.") from None


def _refuse(status: int, text: str, key: str) -> None:
    """Raises the CentralApiError of an answer that is not a 2xx, in plain words and without the key."""
    if 300 <= status < 400:
        raise CentralApiError("error", "Central respondió con una redirección, que no se sigue: revisa la dirección (¿falta https o sobra una ruta?).")
    if status == 401:
        raise CentralApiError("auth", "Central no acepta la clave: puede estar revocada. Crea otra en Ajustes › Apps conectadas de Central.")
    if status == 403:
        scope = ""
        try:
            scope = str(json.loads(text).get("scope") or "")
        except (ValueError, AttributeError):
            pass
        named = f" «{scope}»" if scope in SCOPES else ""
        raise CentralApiError("forbidden", f"La clave de Central no tiene el permiso{named} para esto.")
    if status == 404:
        raise CentralApiError("not_found", "Central no tiene eso (o la dirección no es la de su API).")
    if status == 429:
        raise CentralApiError("unreachable", "Central pide esperar un poco (demasiadas peticiones).")
    if status in (400, 409, 422):
        said = _said(text, key)
        raise CentralApiError("invalid", f"Central no aceptó los datos{': ' + said if said else ''}.")
    if status >= 500:
        raise CentralApiError("unreachable", f"Central no responde bien ahora ({status}).")
    if not 200 <= status < 300:
        raise CentralApiError("error", f"Central respondió con un error ({status}).")


def _no_constant(name: str):
    """NaN and Infinity are not JSON: an answer with them is not understood (it could not be answered on either)."""
    raise CentralApiError("error", "Central devolvió una respuesta que no se entiende.")


def request(target: Connection, method: str, path: str, params: dict | None = None, body: dict | None = None,
            client: httpx.Client | None = None, deadline: float | None = None) -> dict:
    """One call to Central's API; the JSON object it answers or a CentralApiError without the key. With `client`
    (from `session`) the connection is reused and `deadline` bounds the whole reading."""
    if client is None:
        with session(REQUEST_SECONDS) as (own, own_deadline):
            return request(target, method, path, params, body, own, own_deadline)
    status, _, raw = _exchange(target, method, path, params, body, client, deadline, MAX_BYTES, "application/json")
    text = raw.decode("utf-8", errors="replace")
    _refuse(status, text, target.key)
    try:
        data = json.loads(text, parse_constant=_no_constant)
    except ValueError:
        raise CentralApiError("error", "Central devolvió una respuesta que no se entiende (¿es la dirección de Central?).") from None
    if not isinstance(data, dict):
        raise CentralApiError("error", "Central devolvió una respuesta que no se entiende.")
    return data


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
