"""Mail received through Resend (Inbound). Resend has no IMAP: its API lists the received emails and gives, for
each one, a short-lived link to the original message. AgoraOne downloads that original and keeps it like any
other mail (folder «RESEND»), so the Bandeja, the rules and the replies work the same. Read-only: nothing is
changed or deleted in Resend. The API key only goes to api.resend.com, never to the download link."""

import sqlite3
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse

import httpx

from .db import transaction

API = "https://api.resend.com"
FOLDER = "RESEND"
UIDVALIDITY = 1
PAGE = 100
PAUSE = 0.6  # Resend allows a couple of requests per second
TIMEOUT = 30
BUDGET = 40.0  # seconds of one reading: «Leer ahora» answers within the backend's time limit


class InboundError(RuntimeError):
    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


def _get(client: httpx.Client, path: str, key: str, params: dict | None = None) -> dict:
    try:
        answer = client.get(f"{API}{path}", params=params, headers={"Authorization": f"Bearer {key}", "User-Agent": "AgoraOne"}, timeout=TIMEOUT)
    except httpx.HTTPError as error:
        raise InboundError("unreachable", "No se pudo conectar con Resend.") from error
    said = ""
    try:
        said = " ".join(str((answer.json() or {}).get("message") or "").split())[:200] if answer.status_code >= 400 else ""
    except ValueError:
        pass
    if answer.status_code == 400 and "api key" in said.lower():
        raise InboundError("auth", "Resend dice que la clave de API no es válida: revísala y guárdala otra vez.")
    if answer.status_code in (401, 403):
        raise InboundError("auth", "Resend no deja leer lo recibido con esta clave: crea una clave con «Full access» (las de solo envío no leen) y guárdala aquí.")
    if answer.status_code == 429:
        raise InboundError("unreachable", "Resend pide esperar un poco (demasiadas peticiones): se volverá a leer más tarde.")
    if answer.status_code >= 400:
        raise InboundError("error", f"Resend respondió con un error ({answer.status_code}{': ' + said if said else ''}).")
    try:
        data = answer.json()
    except ValueError as error:
        raise InboundError("error", "Resend devolvió una respuesta que no se entiende.") from error
    if not isinstance(data, dict):
        raise InboundError("error", "Resend devolvió una respuesta que no se entiende.")
    return data


def _download(client: httpx.Client, received: dict, limit: int) -> tuple[bytes, bool] | None:
    """The original message and whether it had to be cut at `limit`, from the signed https link Resend gives
    (without the API key, and following no redirect). None when it cannot be had now."""
    link = ((received.get("raw") or {}).get("download_url")) or ""
    if urlparse(link).scheme != "https":
        return None
    try:
        with client.stream("GET", link, timeout=TIMEOUT, follow_redirects=False) as answer:
            if answer.status_code != 200:
                return None
            data = bytearray()
            for piece in answer.iter_bytes():
                data += piece
                if len(data) > limit:
                    return bytes(data[:limit]), True
            return bytes(data), False
    except httpx.HTTPError:
        return None


def _addressed_to(item: dict, address: str) -> bool:
    """Resend lists everything its team received, on every domain: only what was sent to this account's address."""
    wanted = address.casefold()
    for field in ("to", "cc", "bcc"):
        for value in item.get(field) or []:
            if wanted in str(value).casefold():
                return True
    return False


def _new_ids(connection: sqlite3.Connection, account: sqlite3.Row, client: httpx.Client, key: str, batch: int) -> list[str]:
    """Received emails for this address not kept yet and within the account's age limit, oldest first, at most
    `batch`. The list comes newest first; it stops at the first one already kept or too old (at most 2.000 listed)."""
    known = {r["resend_id"] for r in connection.execute("SELECT resend_id FROM resend_message WHERE account_id = ?", (account["id"],))}
    oldest = datetime.now(UTC) - timedelta(days=account["max_age_days"])
    found, after = [], None
    for _ in range(20):
        page = _get(client, "/emails/receiving", key, {"limit": PAGE, **({"after": after} if after else {})})
        items = [i for i in page.get("data") or [] if isinstance(i, dict) and i.get("id")]
        stop = False
        for item in items:
            try:
                created = datetime.fromisoformat(str(item.get("created_at", "")).replace("Z", "+00:00").replace(" ", "T"))
                if created.tzinfo is None:
                    created = created.replace(tzinfo=UTC)
            except ValueError:
                created = datetime.now(UTC)
            if item["id"] in known or created < oldest:
                stop = True
                break
            if _addressed_to(item, account["address"]):
                found.append(item["id"])
        if stop or not page.get("has_more") or not items:
            break
        after = items[-1]["id"]
        time.sleep(PAUSE)
    return list(reversed(found))[:batch]


def sync(connection: sqlite3.Connection, account: sqlite3.Row, key: str, store, limit: int, batch: int,
         client: httpx.Client | None = None, seconds: float = BUDGET) -> int:
    """Keeps the new received emails of a Resend account, within `seconds` (the rest comes in the next reading);
    returns how many. Raises InboundError with the reason. An email whose original cannot be downloaded now is
    not kept (no empty entry): it is tried again next time."""
    own = client is None
    client = client or httpx.Client()
    began = time.monotonic()
    try:
        added = 0
        for resend_id in _new_ids(connection, account, client, key, batch):
            if time.monotonic() - began > seconds:
                break
            time.sleep(PAUSE)
            received = _get(client, f"/emails/receiving/{resend_id}", key)
            got = _download(client, received, limit)
            if got is None:
                raise InboundError("unreachable", "Resend no dio el original de un correo recibido: se volverá a intentar en la próxima lectura.")
            raw, cut = got
            with transaction(connection):
                uid = (connection.execute("SELECT max(uid) FROM resend_message WHERE account_id = ?", (account["id"],)).fetchone()[0] or 0) + 1
                kept = connection.execute("INSERT OR IGNORE INTO resend_message (account_id, resend_id, uid) VALUES (?, ?, ?)", (account["id"], resend_id, uid)).rowcount
                if kept:  # a too large original keeps only what the parser can read, marked as truncated
                    store(connection, account["id"], UIDVALIDITY, uid, raw, limit + 1 if cut else len(raw), FOLDER)
            added += kept
        return added
    finally:
        if own:
            client.close()


def fetch_raw(connection: sqlite3.Connection, account_id: int, uid: int, key: str, limit: int, client: httpx.Client | None = None) -> bytes:
    """The original of a kept Resend email again (for an attachment the user asked for)."""
    row = connection.execute("SELECT resend_id FROM resend_message WHERE account_id = ? AND uid = ?", (account_id, uid)).fetchone()
    if row is None:
        raise InboundError("error", "Ese correo ya no está en Resend.")
    own = client is None
    client = client or httpx.Client()
    try:
        got = _download(client, _get(client, f"/emails/receiving/{row['resend_id']}", key), limit)
    finally:
        if own:
            client.close()
    if got is None:
        raise InboundError("error", "Resend no devolvió el original de ese correo.")
    if got[1]:
        raise InboundError("error", "Ese correo es demasiado grande para abrir sus adjuntos desde AgoraOne.")
    return got[0]
