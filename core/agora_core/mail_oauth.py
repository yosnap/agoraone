"""Microsoft sign-in for mail (OAuth 2 device code flow, user's decision, 14/11/2026).

AgoraOne shows a code, the user enters it at Microsoft's page and accepts; Microsoft never shows AgoraOne
the password. Only the refresh token is kept, in the Keychain; access tokens live one hour in memory and
log in to IMAP with XOAUTH2. The client id is the user's own app registration (public, not a secret).
"""

import json
import re
import sys
import threading
import time
from dataclasses import dataclass, field

import httpx

from . import tls

AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0"
SCOPES = "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access"
CLIENT_SETTING = "mail.microsoftClientId"
_CLIENT_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TIMEOUT = 20


class OAuthError(RuntimeError):
    pass


class TransportError(OAuthError):
    """Microsoft could not be reached (network down, timeout): worth trying again."""


def valid_client_id(value: str) -> bool:
    return bool(_CLIENT_ID.fullmatch(value.strip().lower()))


def client_id(connection) -> str | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (CLIENT_SETTING,)).fetchone()
    return json.loads(row["value"]) if row else None


def save_client_id(connection, value: str | None) -> None:
    if value is None:
        connection.execute("DELETE FROM setting WHERE key = ?", (CLIENT_SETTING,))
        return
    if not valid_client_id(value):
        raise OAuthError("El identificador de la aplicación tiene que ser un GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).")
    connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                       (CLIENT_SETTING, json.dumps(value.strip().lower())))


def _post(http, path: str, data: dict) -> dict:
    try:
        response = http(f"{AUTHORITY}/{path}", data)
    except httpx.HTTPError as error:
        raise TransportError("No se pudo hablar con Microsoft; revisa la conexión.") from error
    try:
        return response.json()
    except ValueError as error:
        raise OAuthError("Microsoft respondió algo que no se entiende.") from error


def default_http(url: str, data: dict):
    return httpx.post(url, data=data, timeout=TIMEOUT, verify=tls.client_context())


@dataclass
class Pending:
    """A sign-in waiting for the user: the code shown, and how it ended."""
    user_code: str
    verification_uri: str
    expires_at: float
    state: str = "waiting"  # waiting · done · declined · expired · error · cancelled
    message: str | None = None

    def current_state(self) -> str:
        return "expired" if self.state == "waiting" and time.time() > self.expires_at else self.state


@dataclass
class Flows:
    """Sign-ins in progress and access tokens in memory, per account."""
    pending: dict[int, Pending] = field(default_factory=dict)
    tokens: dict[int, tuple[str, float]] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


def start(flows: Flows, account_id: int, client: str, save_refresh, http=default_http, sleep=time.sleep) -> Pending:
    """Asks Microsoft for a code and waits for the user in the background. `save_refresh(token)` stores the
    refresh token in the Keychain when the user accepts, and returns False when the account is no longer a
    Microsoft one (nothing is stored then). A new sign-in for the same account replaces the previous one."""
    answer = _post(http, "devicecode", {"client_id": client, "scope": SCOPES})
    if "user_code" not in answer:
        raise OAuthError(_explain(answer))
    pending = Pending(answer["user_code"], answer.get("verification_uri", "https://microsoft.com/devicelogin"),
                      time.time() + int(answer.get("expires_in", 900)))
    with flows.lock:
        previous = flows.pending.get(account_id)
        if previous is not None and previous.state == "waiting":
            previous.state = "cancelled"
        flows.pending[account_id] = pending
    interval = max(1, int(answer.get("interval", 5)))

    def current() -> bool:  # still the sign-in of this account (not cancelled, deleted or replaced)?
        with flows.lock:
            return flows.pending.get(account_id) is pending and pending.state == "waiting"

    def end(state: str, message: str | None = None) -> None:
        with flows.lock:
            pending.message, pending.state = message, state

    def wait():
        nonlocal interval
        try:
            while time.time() < pending.expires_at:
                sleep(interval)
                if not current():
                    return
                try:
                    token = _post(http, "token", {"grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                                                  "client_id": client, "device_code": answer["device_code"]})
                except TransportError:
                    continue  # a network blip: the user may still be typing the code
                if "refresh_token" in token and "access_token" in token:
                    with flows.lock:  # checked and stored together, so a cancelled sign-in never saves anything
                        if flows.pending.get(account_id) is not pending or pending.state != "waiting":
                            return
                        if not save_refresh(token["refresh_token"]):
                            pending.message, pending.state = "Esa cuenta ya no es de Microsoft o se quitó.", "cancelled"
                            return
                        flows.tokens[account_id] = (token["access_token"], time.time() + int(token.get("expires_in", 3600)) - 120)
                        pending.state = "done"
                    return
                error = token.get("error")
                if error == "authorization_pending":
                    continue
                if error == "slow_down":
                    interval += 5
                    continue
                end({"authorization_declined": "declined", "expired_token": "expired"}.get(error, "error"), _explain(token))
                return
            end("expired", _explain({"error": "expired_token"}))
        except Exception as error:  # noqa: BLE001 - a dead thread must never leave the sign-in waiting forever
            print(f"AgoraOne núcleo: inicio de sesión de Microsoft interrumpido ({type(error).__name__})", file=sys.stderr)
            end("error", "No se pudo terminar el inicio de sesión de Microsoft; vuelve a intentarlo.")

    threading.Thread(target=wait, daemon=True).start()
    return pending


def access_token(flows: Flows, account_id: int, client: str, refresh: str, save_refresh, http=default_http) -> str:
    """A valid access token, renewed with the refresh token when needed (Microsoft may rotate it)."""
    with flows.lock:
        cached = flows.tokens.get(account_id)
    if cached and cached[1] > time.time():
        return cached[0]
    token = _post(http, "token", {"grant_type": "refresh_token", "client_id": client, "refresh_token": refresh, "scope": SCOPES})
    if "access_token" not in token:
        raise OAuthError(_explain(token))
    if token.get("refresh_token") and token["refresh_token"] != refresh:
        save_refresh(token["refresh_token"])
    with flows.lock:
        flows.tokens[account_id] = (token["access_token"], time.time() + int(token.get("expires_in", 3600)) - 120)
    return token["access_token"]


def forget(flows: Flows, account_id: int) -> None:
    """Cancels a sign-in in progress (its thread stops without saving) and drops the token in memory."""
    with flows.lock:
        pending = flows.pending.pop(account_id, None)
        if pending is not None and pending.state == "waiting":
            pending.state = "cancelled"
        flows.tokens.pop(account_id, None)


def xoauth2(user: str, token: str) -> bytes:
    return f"user={user}\x01auth=Bearer {token}\x01\x01".encode()


def _explain(answer: dict) -> str:
    error = answer.get("error", "")
    known = {
        "invalid_client": "Microsoft no reconoce el identificador de la aplicación o no tiene activados los flujos de cliente público.",
        "unauthorized_client": "La aplicación registrada no admite cuentas de este tipo; revisa los tipos de cuenta admitidos.",
        "invalid_grant": "El permiso de Microsoft caducó o se revocó: vuelve a conectar la cuenta.",
        "authorization_declined": "Se rechazó el permiso en la página de Microsoft.",
        "expired_token": "El código caducó antes de introducirlo; pide uno nuevo.",
        "invalid_scope": "La aplicación registrada no tiene los permisos de IMAP y SMTP de Outlook.",
    }
    return known.get(error, f"Microsoft no aceptó la petición ({error or 'sin detalle'}).")
