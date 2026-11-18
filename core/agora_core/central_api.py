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
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from .db import transaction

SECRET = "central-api-key"  # account of the key in the secret store
SETTING = "central.connection"
SUGGESTED_URL = "https://central.example.com"
SCOPES = ("lectura", "presupuestos", "escritura")
TIMEOUT = httpx.Timeout(15, connect=5)
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
        parts.port  # noqa: B018 - raises on a port that is not a number
    except ValueError:
        raise CentralApiError("config", "La dirección de Central no es válida.") from None
    if parts.scheme not in ("https", "http") or not host or parts.username or parts.password or parts.query or parts.fragment:
        raise CentralApiError("config", "La dirección de Central no es válida: solo https://servidor (sin usuario, ? ni #).")
    if parts.scheme == "http" and host not in _LOOPBACK:
        raise CentralApiError("config", "Fuera de este equipo, Central solo se conecta por https: la clave nunca viaja sin cifrar.")
    if not all(c.isascii() and c.isprintable() and not c.isspace() for c in value.strip()):
        raise CentralApiError("config", "La dirección de Central no es válida.")
    netloc = parts.netloc.rsplit("@", 1)[-1]
    return f"{parts.scheme}://{netloc}{parts.path.rstrip('/')}"


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


def request(target: Connection, method: str, path: str, params: dict | None = None, body: dict | None = None) -> dict:
    """One call to Central's API; the JSON object it answers or a CentralApiError without the key."""
    if not path.startswith("/api/v1/"):
        raise CentralApiError("error", "Ruta de Central no permitida.")
    url = normalize_url(target.url)
    headers = {"Authorization": f"Bearer {target.key}", "Accept": "application/json", "User-Agent": "AgoraOne"}
    try:
        with httpx.Client(transport=TRANSPORT, timeout=TIMEOUT, follow_redirects=False) as client:
            with client.stream(method, f"{url}{path}", params=params, json=body, headers=headers) as answer:
                declared = answer.headers.get("content-length") or "0"
                if not declared.isdigit() or int(declared) > MAX_BYTES:
                    raise CentralApiError("error", "Central devolvió una respuesta demasiado grande.")
                chunks, read = [], 0
                for chunk in answer.iter_bytes():
                    read += len(chunk)
                    if read > MAX_BYTES:
                        raise CentralApiError("error", "Central devolvió una respuesta demasiado grande.")
                    chunks.append(chunk)
                status = answer.status_code
                text = b"".join(chunks).decode("utf-8", errors="replace")
    except CentralApiError:
        raise
    except httpx.TimeoutException:
        raise CentralApiError("unreachable", "Central no respondió a tiempo.") from None
    except httpx.HTTPError:
        raise CentralApiError("unreachable", "No se pudo conectar con Central: comprueba la dirección y que esté en marcha.") from None
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
    if status in (400, 422):
        said = _said(text, target.key)
        raise CentralApiError("invalid", f"Central no aceptó los datos{': ' + said if said else ''}.")
    if status >= 500:
        raise CentralApiError("unreachable", f"Central no responde bien ahora ({status}).")
    if not 200 <= status < 300:
        raise CentralApiError("error", f"Central respondió con un error ({status}).")
    try:
        data = json.loads(text)
    except ValueError:
        raise CentralApiError("error", "Central devolvió una respuesta que no se entiende (¿es la dirección de Central?).") from None
    if not isinstance(data, dict):
        raise CentralApiError("error", "Central devolvió una respuesta que no se entiende.")
    return data


def status(target: Connection) -> dict:
    """`GET /api/v1/estado`: Central's version and the permissions of the key."""
    data = request(target, "GET", "/api/v1/estado")
    scopes = [s for s in data.get("scopes") or [] if s in SCOPES] if isinstance(data.get("scopes"), list) else []
    version = data.get("version")
    runtime = data.get("runtime")
    return {"version": str(version)[:40] if version is not None else None, "api": str(data.get("api") or "")[:10] or None,
            "scopes": scopes, "runtime": runtime if runtime in ("production", "local") else None}


def _rows(data: dict, name: str) -> list[dict]:
    value = data.get(name)
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


PROJECT_PAGES = 25  # 200 projects a page: up to 5000, far more than anyone has


def read_all(target: Connection) -> dict:
    """What the snapshot needs, in the same shape as the stdio reading: clients, projects, websites, servers and
    each client's contact. Needs the `lectura` permission."""
    if "lectura" not in status(target)["scopes"]:
        raise CentralApiError("forbidden", "La clave de Central no tiene el permiso «lectura»: no se leen clientes ni servidores.")
    clients = _rows(request(target, "GET", "/api/v1/clientes"), "clients")
    projects: list[dict] = []
    cursor = None
    for _ in range(PROJECT_PAGES):
        page = request(target, "GET", "/api/v1/proyectos", {"limite": 200, **({"cursor": cursor} if cursor else {})})
        projects += _rows(page, "projects")
        cursor = page.get("nextCursor")
        if not isinstance(cursor, str) or not cursor:
            break
    websites = _rows(request(target, "GET", "/api/v1/webs"), "websites")
    servers = _rows(request(target, "GET", "/api/v1/servidores"), "servers")
    details = {c["name"]: {k: c.get(k) for k in ("company", "email", "phone", "taxId")} for c in clients if isinstance(c.get("name"), str)}
    return {"clients": clients, "projects": projects, "websites": websites, "servers": servers, "details": details}


def create_quote(target: Connection, quote: dict) -> dict:
    """`POST /api/v1/presupuestos`: a draft with the next number of the year. Needs the `presupuestos` permission."""
    data = request(target, "POST", "/api/v1/presupuestos", body=quote)
    return {"id": data.get("id"), "number": data.get("number")}
