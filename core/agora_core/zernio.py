"""Zernio's API (WhatsApp over Meta's Cloud API), read-only: the connected accounts, their conversations and each
conversation's messages. Nothing is sent, marked as read or changed: the «typing» call, which marks a chat as
read, is never used. The API key goes only in the Authorization header to zernio.com; it never appears in
errors, logs or answers. Requests are spaced so a reading stays under Zernio's 60 per minute."""

import threading
import time
from urllib.parse import quote

import httpx

API = "https://zernio.com/api/v1"
SECRET = "zernio-api-key"  # Keychain account of the key
PAGE = 100
PAUSE = 1.05  # seconds between requests: under 60 per minute
TIMEOUT = httpx.Timeout(10, connect=5)  # short: «Leer ahora» must answer within the backend's minute

_PACE = threading.Lock()
_last = 0.0


class ZernioError(RuntimeError):
    """`status` is the account state it leaves: 'auth', 'unreachable' or 'error'."""

    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


def _wait_turn() -> None:
    """Spaces every request to Zernio by PAUSE seconds, whoever makes it (background reading or «Leer ahora»)."""
    global _last
    with _PACE:
        left = _last + PAUSE - time.monotonic()
        if left > 0:
            time.sleep(left)
        _last = time.monotonic()


def _said(answer: httpx.Response, key: str) -> str:
    """Zernio's own short reason for an error, without the key should it ever echo it."""
    try:
        data = answer.json()
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    reason = data.get("error") or data.get("message") or ""
    if isinstance(reason, dict):
        reason = reason.get("message") or ""
    text = " ".join(str(reason).split())[:200]
    return text.replace(key, "***") if key else text


def _get(path: str, key: str, params: dict | None = None, client: httpx.Client | None = None) -> dict | list:
    if not key:
        raise ZernioError("auth", "Falta la clave de API de Zernio.")
    own = client is None
    client = client or httpx.Client()
    _wait_turn()
    try:
        answer = client.get(f"{API}{path}", params=params, headers={"Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": "AgoraOne"},
                            timeout=TIMEOUT, follow_redirects=False)
    except httpx.HTTPError as error:
        raise ZernioError("unreachable", "No se pudo conectar con Zernio: se volverá a leer más tarde.") from error
    finally:
        if own:
            client.close()
    if answer.status_code in (401, 403):
        raise ZernioError("auth", "Zernio no acepta la clave de API: créala otra vez en su panel (Settings › API Keys) y guárdala aquí.")
    if answer.status_code == 429:
        raise ZernioError("unreachable", "Zernio pide esperar un poco (demasiadas peticiones): se volverá a leer más tarde.")
    if answer.status_code >= 500:
        raise ZernioError("unreachable", f"Zernio no responde bien ahora ({answer.status_code}): se volverá a leer más tarde.")
    if not 200 <= answer.status_code < 300:
        said = _said(answer, key)
        raise ZernioError("error", f"Zernio respondió con un error ({answer.status_code}{': ' + said if said else ''}).")
    try:
        data = answer.json()
    except ValueError as error:
        raise ZernioError("error", "Zernio devolvió una respuesta que no se entiende.") from error
    if not isinstance(data, (dict, list)):
        raise ZernioError("error", "Zernio devolvió una respuesta que no se entiende.")
    return data


def _items(data: dict | list, *names: str) -> list[dict]:
    """The list of a Zernio answer, under the first of `names` that holds one (or the answer itself)."""
    found = data
    if isinstance(data, dict):
        found = next((data[name] for name in names if isinstance(data.get(name), list)), [])
    return [item for item in found if isinstance(item, dict)] if isinstance(found, list) else []


def _next(data: dict | list) -> str | None:
    pagination = data.get("pagination") if isinstance(data, dict) else None
    if isinstance(pagination, dict) and pagination.get("hasMore") and pagination.get("nextCursor"):
        return str(pagination["nextCursor"])
    return None


def accounts(key: str, client: httpx.Client | None = None) -> list[dict]:
    """Every account connected to Zernio (WhatsApp and any other platform)."""
    return _items(_get("/accounts", key, client=client), "accounts", "data")


def conversations(key: str, cursor: str | None = None, client: httpx.Client | None = None) -> tuple[list[dict], str | None]:
    """One page of the inbox's conversations and the cursor of the next one (None when there is no more)."""
    params = {"limit": PAGE, "platform": "whatsapp", "sortOrder": "desc", **({"cursor": cursor} if cursor else {})}
    data = _get("/inbox/conversations", key, params, client)
    return _items(data, "data", "conversations"), _next(data)


def messages(key: str, account_remote_id: str, conversation_id: str, cursor: str | None = None,
             client: httpx.Client | None = None) -> tuple[list[dict], str | None]:
    """One page of a conversation's messages, newest first (Zernio needs the account), and the cursor of the next,
    older one. Zernio's default order is oldest first: an answer not confirming the newest-first order is refused,
    because reading would then stop before what is new."""
    params = {"accountId": account_remote_id, "limit": PAGE, "sortOrder": "desc", **({"cursor": cursor} if cursor else {})}
    data = _get(f"/inbox/conversations/{quote(conversation_id, safe='')}/messages", key, params, client)
    if not isinstance(data, dict) or data.get("sortOrderApplied") != "desc":
        raise ZernioError("error", "Zernio no devolvió los mensajes del más nuevo al más antiguo: no se lee esa conversación.")
    return _items(data, "messages", "data"), _next(data)
