"""What every connector reached through a web API shares: a base URL (not secret, kept in `setting`) and an access
key kept only in the system's secret store (Keychain, Windows Credential Manager or Secret Service), each connector
under its own account. A `WebApiSpec` says which ones, and every function here takes it first.

Safety of the key: https is required except on loopback (`localhost`, `127.0.0.1`, `::1`); redirections are never
followed, so a 30x can never carry the key to another host; the key goes only in the Authorization header and is
scrubbed from any text of the service that ends up in an error; answers are size-capped; only paths under the
spec's prefix are asked. Errors say what happened in plain words and never include the key, the request headers or
the raw answer."""

import json
import re
import sqlite3
import time
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from .db import transaction

TIMEOUT = httpx.Timeout(15, connect=5)  # per operation (connect, each read)
REQUEST_SECONDS = 60  # a whole request, however slowly the service drips its answer
MAX_BYTES = 8 * 1024 * 1024
NO_STORE = "No hay un almacén de secretos activo (Secret Service, Llavero o Administrador de credenciales): sin él no se guarda la clave."
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}
_LABEL = re.compile(r"(?!-)[a-z0-9-]{1,63}(?<!-)")


def _real_network() -> httpx.BaseTransport | None:
    return None


@dataclass(frozen=True)
class WebApiSpec:
    """One web API: where its key and URL are kept, what its key looks like and how it is named in messages.
    `transport` is read at each connection (tests answer with an httpx.MockTransport; None is the real network).
    `rate_limited` is the status of a 429: `busy` unless the connector already said something else before."""
    secret: str  # account of the key in the secret store
    setting: str  # row of `setting` with its URL
    key_pattern: str  # a regular expression the whole key matches
    key_hint: str  # how a key looks, e.g. «empieza por «cen_»»
    key_source: str  # where the user creates a key
    example_url: str
    name: str
    path_prefix: str = "/api/v1/"
    scopes: tuple[str, ...] = ()
    rate_limited: str = "busy"
    transport: Callable[[], httpx.BaseTransport | None] = _real_network


class WebApiError(RuntimeError):
    """`status`: 'config' (URL or key not valid), 'auth' (key refused), 'forbidden' (key without that permission),
    'not_found', 'invalid' (the service refused the data), 'unreachable', 'busy' (asked to wait) or 'error'."""

    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


def normalize_url(spec: WebApiSpec, value: object) -> str:
    """The base URL (scheme, host, port and an optional path, without a trailing «/»)."""
    name = spec.name
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 300:
        raise WebApiError("config", f"Escribe la dirección de {name}, por ejemplo {spec.example_url}.")
    try:
        parts = urlsplit(value.strip())
        host = (parts.hostname or "").lower()
        port = parts.port  # raises on a port that is not a number or out of range
    except ValueError:
        raise WebApiError("config", f"La dirección de {name} no es válida.") from None
    if port is not None and not 1 <= port <= 65535:
        raise WebApiError("config", f"La dirección de {name} no es válida: el puerto va de 1 a 65535.")
    if host and ":" not in host and not _valid_host(host):
        raise WebApiError("config", f"La dirección de {name} no es válida: revisa el nombre del servidor.")
    if parts.scheme not in ("https", "http") or not host or parts.username or parts.password or parts.query or parts.fragment:
        raise WebApiError("config", f"La dirección de {name} no es válida: solo https://servidor (sin usuario, ? ni #).")
    if parts.scheme == "http" and host not in _LOOPBACK:
        raise WebApiError("config", f"Fuera de este equipo, {name} solo se conecta por https: la clave nunca viaja sin cifrar.")
    if not all(c.isascii() and c.isprintable() and not c.isspace() for c in value.strip()):
        raise WebApiError("config", f"La dirección de {name} no es válida.")
    netloc = parts.netloc.rsplit("@", 1)[-1]
    return f"{parts.scheme}://{netloc}{parts.path.rstrip('/')}"


def url_problem(spec: WebApiSpec, value: object) -> str | None:
    try:
        normalize_url(spec, value)
    except WebApiError as error:
        return str(error)
    return None


def _valid_host(host: str) -> bool:
    """A host name made of valid labels (international names through idna), never empty labels like «a..b»."""
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return False
    return len(ascii_host) <= 253 and all(_LABEL.fullmatch(label) for label in ascii_host.split("."))


def origin(spec: WebApiSpec, url: str) -> tuple[str, str, int]:
    """Scheme, host and port of a valid URL: a key saved for one origin never travels to another one unasked."""
    parts = urlsplit(normalize_url(spec, url))
    return parts.scheme, (parts.hostname or "").lower(), parts.port or (443 if parts.scheme == "https" else 80)


def same_origin(spec: WebApiSpec, a: str | None, b: str | None) -> bool:
    try:
        return bool(a and b) and origin(spec, a) == origin(spec, b)
    except WebApiError:
        return False


def key_problem(spec: WebApiSpec, key: object) -> str | None:
    if not isinstance(key, str):
        return f"La clave de {spec.name} debe ser texto."
    if not re.fullmatch(spec.key_pattern, key.strip()):
        return f"La clave de {spec.name} no parece válida: {spec.key_hint}; cópiala entera desde {spec.key_source}."
    return None


def saved_url(spec: WebApiSpec, connection: sqlite3.Connection) -> str | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (spec.setting,)).fetchone()
    if not row:
        return None
    try:
        url = json.loads(row["value"]).get("url")
    except (ValueError, AttributeError):
        return None
    return url if isinstance(url, str) and url_problem(spec, url) is None else None


def save_url(spec: WebApiSpec, connection: sqlite3.Connection, url: str | None) -> None:
    with transaction(connection):
        if url is None:
            connection.execute("DELETE FROM setting WHERE key = ?", (spec.setting,))
        else:
            connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                               (spec.setting, json.dumps({"url": normalize_url(spec, url)})))


def read_key(spec: WebApiSpec, secrets) -> str | None:
    """The key from the secret store; a store that does not work is said plainly (never stored in plain text)."""
    try:
        key = secrets.get(spec.secret)
    except Exception:  # noqa: BLE001 - keyring raises its own kinds per system; none of them carries the key
        raise WebApiError("config", NO_STORE) from None
    return key if isinstance(key, str) and key else None


def write_key(spec: WebApiSpec, secrets, key: str | None) -> None:
    try:
        secrets.put(spec.secret, key)
    except Exception:  # noqa: BLE001 - as in read_key
        raise WebApiError("config", NO_STORE) from None


@dataclass(frozen=True)
class Connection:
    """URL and key of a service reached over HTTP. `repr` never shows the key."""
    url: str
    key: str

    def __repr__(self) -> str:
        return f"Connection(url={self.url!r})"


def connection_of(spec: WebApiSpec, connection: sqlite3.Connection, secrets) -> Connection | None:
    """The saved connection when there are both a URL and a key; None otherwise (or with no working store)."""
    url = saved_url(spec, connection)
    if not url:
        return None
    try:
        key = read_key(spec, secrets)
    except WebApiError:
        return None
    return Connection(url, key) if key else None


def said(answer_text: str, key: str) -> str:
    """The service's own short reason (`detail` or `error`), without the key should it ever echo it."""
    try:
        data = json.loads(answer_text)
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    reason = str(data.get("detail") or data.get("error") or "")
    if key:  # before squeezing spaces or cutting, so no part of it survives; also a key split by spaces or line breaks
        reason = re.sub(r"\s*".join(map(re.escape, key)), "***", reason)
    text = " ".join(reason.split())
    return text[:200]


@contextmanager
def session(spec: WebApiSpec, seconds: float):
    """One connection for several requests, with a deadline for all of them."""
    with httpx.Client(transport=spec.transport(), timeout=TIMEOUT, follow_redirects=False) as client:
        yield client, time.monotonic() + seconds


def exchange(spec: WebApiSpec, target: Connection, method: str, path: str, params: dict | None, body: dict | None,
             client: httpx.Client, deadline: float | None, max_bytes: int, accept: str,
             request_seconds: float = REQUEST_SECONDS) -> tuple[int, str, bytes]:
    """One call: status, content type and the bytes of the answer (at most `max_bytes`), or a WebApiError."""
    name = spec.name
    if not path.startswith(spec.path_prefix):
        raise WebApiError("error", f"Ruta de {name} no permitida.")
    url = normalize_url(spec, target.url)
    headers = {"Authorization": f"Bearer {target.key}", "Accept": accept, "User-Agent": "AgoraOne"}
    until = min(deadline or float("inf"), time.monotonic() + request_seconds)
    late = WebApiError("unreachable", f"{name} no respondió a tiempo.")
    too_big = WebApiError("error", f"{name} devolvió una respuesta demasiado grande.")
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
    except WebApiError:
        raise
    except httpx.TimeoutException:
        raise late from None
    except (httpx.InvalidURL, UnicodeError, ValueError):
        raise WebApiError("config", f"La dirección de {name} no es válida.") from None
    except httpx.HTTPError:
        raise WebApiError("unreachable", f"No se pudo conectar con {name}: comprueba la dirección y que esté en marcha.") from None


def refuse(spec: WebApiSpec, status: int, text: str, key: str) -> None:
    """Raises the WebApiError of an answer that is not a 2xx, in plain words and without the key."""
    name = spec.name
    if 300 <= status < 400:
        raise WebApiError("error", f"{name} respondió con una redirección, que no se sigue: revisa la dirección (¿falta https o sobra una ruta?).")
    if status == 401:
        raise WebApiError("auth", f"{name} no acepta la clave: puede estar revocada. Crea otra en {spec.key_source}.")
    if status == 403:
        scope = ""
        try:
            scope = str(json.loads(text).get("scope") or "")
        except (ValueError, AttributeError):
            pass
        named = f" «{scope}»" if scope in spec.scopes else ""
        raise WebApiError("forbidden", f"La clave de {name} no tiene el permiso{named} para esto.")
    if status == 404:
        raise WebApiError("not_found", f"{name} no tiene eso (o la dirección no es la de su API).")
    if status == 429:
        raise WebApiError(spec.rate_limited, f"{name} pide esperar un poco (demasiadas peticiones).")
    if status in (400, 409, 422):
        reason = said(text, key)
        raise WebApiError("invalid", f"{name} no aceptó los datos{': ' + reason if reason else ''}.")
    if status >= 500:
        raise WebApiError("unreachable", f"{name} no responde bien ahora ({status}).")
    if not 200 <= status < 300:
        raise WebApiError("error", f"{name} respondió con un error ({status}).")


def json_object(spec: WebApiSpec, text: str) -> dict:
    """The JSON object of an answer; NaN and Infinity are not JSON, so an answer with them is not understood."""
    def no_constant(_name: str):
        raise WebApiError("error", f"{spec.name} devolvió una respuesta que no se entiende.")
    try:
        data = json.loads(text, parse_constant=no_constant)
    except ValueError:
        raise WebApiError("error", f"{spec.name} devolvió una respuesta que no se entiende (¿es la dirección de {spec.name}?).") from None
    if not isinstance(data, dict):
        raise WebApiError("error", f"{spec.name} devolvió una respuesta que no se entiende.")
    return data


def request(spec: WebApiSpec, target: Connection, method: str, path: str, params: dict | None = None, body: dict | None = None,
            client: httpx.Client | None = None, deadline: float | None = None, max_bytes: int = MAX_BYTES,
            request_seconds: float = REQUEST_SECONDS) -> dict:
    """One call to the API; the JSON object it answers or a WebApiError without the key. With `client` (from
    `session`) the connection is reused and `deadline` bounds the whole reading."""
    if client is None:
        with session(spec, request_seconds) as (own, own_deadline):
            return request(spec, target, method, path, params, body, own, own_deadline, max_bytes, request_seconds)
    status, _, raw = exchange(spec, target, method, path, params, body, client, deadline, max_bytes, "application/json", request_seconds)
    text = raw.decode("utf-8", errors="replace")
    refuse(spec, status, text, target.key)
    return json_object(spec, text)
