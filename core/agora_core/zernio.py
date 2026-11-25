"""Zernio's API (WhatsApp over Meta's Cloud API): the connected accounts, their conversations and each
conversation's messages, and one write, `send_message`, used only for the reply the user confirmed (chat_send).
Nothing is marked as read, deleted or changed: neither the «typing» call nor the «read» one, which mark a chat as
read, is ever used. The API key goes only in the Authorization header to zernio.com; it never appears in errors,
logs or answers. Requests are spaced so AgoraOne stays under Zernio's 60 per minute."""

import threading
import time
from urllib.parse import quote

import httpx

from . import tls

API = "https://zernio.com/api/v1"
SECRET = "zernio-api-key"  # Keychain account of the key
PAGE = 100
PAUSE = 1.05  # seconds between requests: under 60 per minute
TIMEOUT = httpx.Timeout(10, connect=5)  # short: «Leer ahora» must answer within the backend's minute
SEND_TIMEOUT = httpx.Timeout(25, connect=5)  # a send waits for Meta's answer, still within the backend's minute

_PACE = threading.Lock()
_last = 0.0


class ZernioError(RuntimeError):
    """`status` is the account state it leaves: 'auth', 'unreachable' or 'error'."""

    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


class ZernioSendError(ZernioError):
    """A send that failed. `sent` is False when the message surely did not leave and None when nobody can know
    (a time limit, a cut connection or a server error after the request went out): that one is never retried."""

    def __init__(self, status: str, message: str, sent: bool | None, code: str | None = None):
        super().__init__(status, message)
        self.sent = sent
        self.code = code


def _headers(key: str) -> dict:
    return {"Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": "AgoraOne"}


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
    client = client or httpx.Client(verify=tls.client_context())
    _wait_turn()
    try:
        answer = client.get(f"{API}{path}", params=params, headers=_headers(key), timeout=TIMEOUT, follow_redirects=False)
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


# Meta's error codes for a text that WhatsApp refused, in the user's words (never the raw answer).
_META_REFUSALS = {
    "131047": "WhatsApp lo rechazó porque han pasado más de 24 h desde su último mensaje: solo deja responder con plantillas aprobadas.",
    "131056": "WhatsApp lo rechazó por demasiados mensajes seguidos a este contacto: espera unos minutos.",
    "131026": "WhatsApp no puede entregar mensajes a ese número (puede que no use WhatsApp o que te haya bloqueado).",
    "131049": "WhatsApp no lo entregó para no saturar al contacto: prueba más tarde.",
    "131031": "Meta tiene bloqueada la cuenta de WhatsApp Business: revísala en WhatsApp Manager.",
}
UNKNOWN = ("No se sabe si el mensaje ha llegado: Zernio no confirmó el envío a tiempo. No se vuelve a intentar; "
           "compruébalo en el móvil o con «Leer ahora».")


def _meta_code(answer: httpx.Response) -> str | None:
    try:
        data = answer.json()
    except ValueError:
        return None
    platform = data.get("platformError") if isinstance(data, dict) else None
    code = platform.get("code") if isinstance(platform, dict) else None
    if isinstance(code, bool) or not isinstance(code, (int, str)):
        return None
    text = str(code).strip()
    return text if text.isdigit() and len(text) <= 10 else None


def send_message(key: str, account_remote_id: str, conversation_id: str, text: str, idempotency: str,
                 client: httpx.Client | None = None) -> str | None:
    """Sends one text to a conversation, exactly once: no automatic retry, and an `Idempotency-Key` so Zernio itself
    answers a repeated request with the first result instead of sending again. Only the account and the text go: no
    attachment, template, read or «typing» option. Returns WhatsApp's message id when Zernio gives it. Raises
    ZernioSendError, telling whether the message surely did not leave (`sent=False`) or nobody can know (`sent=None`)."""
    if not key:
        raise ZernioSendError("auth", "Falta la clave de API de Zernio: no se ha enviado.", sent=False)
    own = client is None
    client = client or httpx.Client(verify=tls.client_context())
    _wait_turn()
    try:
        answer = client.post(f"{API}/inbox/conversations/{quote(conversation_id, safe='')}/messages",
                             json={"accountId": account_remote_id, "message": text},
                             headers={**_headers(key), "Idempotency-Key": idempotency}, timeout=SEND_TIMEOUT, follow_redirects=False)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as error:
        raise ZernioSendError("unreachable", "No se pudo conectar con Zernio: no se ha enviado.", sent=False) from error
    except httpx.HTTPError as error:  # the request may have gone out: a time limit or a cut answer
        raise ZernioSendError("unknown", UNKNOWN, sent=None) from error
    finally:
        if own:
            client.close()
    status = answer.status_code
    if 200 <= status < 300:
        try:
            data = answer.json()
        except ValueError:
            return None
        found = data.get("data") if isinstance(data, dict) else None
        ident = found.get("messageId") if isinstance(found, dict) else None
        return (ident.strip()[:200] or None) if isinstance(ident, str) else None
    if status in (401, 403):
        raise ZernioSendError("auth", "Zernio no acepta la clave de API: no se ha enviado. Créala otra vez en su panel y guárdala en Ajustes.", sent=False)
    if status == 402:
        raise ZernioSendError("error", "Zernio pide saldo o has llegado al límite de tu plan: no se ha enviado.", sent=False)
    if status == 409:  # the same Idempotency-Key is still in flight: the first request may be sending it
        raise ZernioSendError("unknown", UNKNOWN, sent=None)
    if status == 429:
        raise ZernioSendError("unreachable", "Zernio pide esperar un poco (demasiadas peticiones): no se ha enviado.", sent=False)
    if status >= 500:  # Zernio documents that a platform failure may not say whether it was delivered
        raise ZernioSendError("unknown", UNKNOWN, sent=None)
    code = _meta_code(answer)
    reason = _META_REFUSALS.get(code or "")
    if reason:
        raise ZernioSendError("error", f"{reason} No se ha enviado.", sent=False, code=code)
    raise ZernioSendError("error", f"Zernio rechazó el mensaje ({status}{f', código de WhatsApp {code}' if code else ''}): no se ha enviado.",
                          sent=False, code=code)
