"""WhatsApp read through Zernio, read-only (no webhook: polled every few minutes and with «Leer ahora»).

A reading registers the WhatsApp accounts Zernio has, lists the conversations and asks for the messages only of
those whose updatedTime changed since their messages were last read (the first time, those of the account's
last `max_age_days`). Messages are kept once (INSERT OR IGNORE) as data, never as instructions; attachments keep
their kind and type, never their link. Each reading stops after `seconds` and the rest comes in the next one.
"""

import json
import sqlite3
import sys
import threading
import time
from datetime import UTC, datetime, timedelta

import httpx

from . import zernio
from .db import DB_NAME, connect, now, transaction

BUDGET = 40.0  # seconds of one reading: «Leer ahora» answers within the backend's time limit
SYNC_SECONDS = 300
MAX_CONVERSATION_PAGES = 30
MAX_MESSAGE_PAGES = 5  # per conversation and reading; what is left goes on in the next one
# No request starts this close to the end of the budget: one more (pause and time limit) still fits in the backend's minute.
REQUEST_MARGIN = 12.0
BODY_LIMIT = 20_000
UNSUPPORTED = "[Unsupported message]"
SETTING = "chat_sync"  # how the last reading went, for Settings (never the key)
GONE = "Zernio ya no tiene esta cuenta: vuelve a conectarla en el panel de Zernio. Lo ya leído se conserva."

_LOCK = threading.Lock()
_clock = time.monotonic  # the reading's own clock, replaceable in tests without touching the time module


def parse_moment(value) -> datetime | None:
    """A Zernio or stored time as an aware UTC datetime; None for anything that is not one."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def _iso(value) -> str | None:
    moment = parse_moment(value)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ") if moment else None


def _text(value, limit: int) -> str | None:
    """A short text field from Zernio, trimmed; None for anything that is not a non-empty string or number."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    return str(value).strip()[:limit] or None


def _phone_like(value) -> str | None:
    text = _text(value, 40)
    return text if text and text.lstrip("+").replace(" ", "").isdigit() else None


def _remote_id(item: dict) -> str | None:
    return _text(item.get("_id") or item.get("id") or item.get("accountId"), 100)


def message_fields(item: dict) -> dict | None:
    """What is kept of one Zernio message, or None when it cannot be kept (no id or an unknown direction).
    A message WhatsApp did not deliver is marked unsupported, without text; attachment links are dropped."""
    remote_id = _text(item.get("id") or item.get("_id"), 200)
    direction = item.get("direction")
    if not remote_id or direction not in ("incoming", "outgoing"):
        return None
    meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    text = item.get("message") if isinstance(item.get("message"), str) else None
    unsupported = bool(meta.get("unsupported")) or (text or "").strip() == UNSUPPORTED
    attachments = [{"type": _text(a.get("type"), 40), "mime": _text(a.get("mimeType"), 100)}
                   for a in item.get("attachments") or [] if isinstance(a, dict)]
    return {
        "remote_id": remote_id, "direction": direction, "sender_name": _text(item.get("senderName"), 120),
        "phone": _phone_like(item.get("senderPhoneNumber")),
        "body": None if unsupported or not text or not text.strip() else text[:BODY_LIMIT], "unsupported": int(unsupported),
        "attachments": json.dumps(attachments), "source": _text(meta.get("source"), 60),
        "sent_at": _iso(item.get("sentAt")) or _iso(item.get("createdAt")),
    }


def _statuses(connection: sqlite3.Connection) -> dict[int, str]:
    return {r["id"]: r["status"] for r in connection.execute("SELECT id, status FROM chat_account WHERE enabled = 1")}


def _mark(connection: sqlite3.Connection, before: dict[int, str], status: str, error: str | None) -> None:
    """The reading's outcome on the enabled accounts it read, unless the user changed them meanwhile (paused one, or
    saved a new key, which leaves them pending)."""
    for account_id, was in before.items():
        connection.execute("UPDATE chat_account SET status = ?, last_error = ?, last_sync_at = ? WHERE id = ? AND enabled = 1 AND status = ?",
                           (status, error, now(), account_id, was))


def _remember(connection: sqlite3.Connection, result: dict) -> None:
    connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                       (SETTING, json.dumps({**result, "at": now()})))


def last_result(connection: sqlite3.Connection) -> dict | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    try:
        return json.loads(row["value"]) if row else None
    except ValueError:
        return None


def _register(connection: sqlite3.Connection, remote: list[dict]) -> dict[str, sqlite3.Row]:
    """Creates or updates the WhatsApp accounts Zernio has; those it no longer has are marked, never deleted.
    Returns the enabled ones by Zernio id."""
    seen = set()
    with transaction(connection):
        for item in remote:
            remote_id = _remote_id(item)
            if not remote_id or str(item.get("platform") or "").lower() != "whatsapp":
                continue
            seen.add(remote_id)
            meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            phone = _text(meta.get("displayPhoneNumber"), 40)
            label = _text(item.get("displayName") or item.get("name") or item.get("username"), 80)
            connection.execute(
                """INSERT INTO chat_account (provider, remote_id, phone, label, created_at) VALUES ('zernio', ?, ?, ?, ?)
                   ON CONFLICT (remote_id) DO UPDATE SET phone = coalesce(excluded.phone, phone), label = coalesce(excluded.label, label)""",
                (remote_id, phone, label, now()))
        for r in connection.execute("SELECT id, remote_id FROM chat_account").fetchall():
            if r["remote_id"] not in seen:
                connection.execute("UPDATE chat_account SET status = 'error', last_error = ?, last_sync_at = ? WHERE id = ?", (GONE, now(), r["id"]))
    rows = connection.execute("SELECT * FROM chat_account WHERE enabled = 1").fetchall()
    return {r["remote_id"]: r for r in rows if r["remote_id"] in seen}


def _conversation(connection: sqlite3.Connection, account: sqlite3.Row, item: dict) -> tuple[sqlite3.Row, datetime | None] | None:
    """Keeps a listed conversation's participant and returns its row and Zernio's updatedTime."""
    remote_id = _text(item.get("id") or item.get("_id"), 100)
    if not remote_id:
        return None
    connection.execute(
        """INSERT INTO chat_conversation (account_id, remote_id, participant_id, participant_name, participant_phone) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (account_id, remote_id) DO UPDATE SET participant_id = coalesce(excluded.participant_id, participant_id),
             participant_name = coalesce(excluded.participant_name, participant_name), participant_phone = coalesce(participant_phone, excluded.participant_phone)""",
        (account["id"], remote_id, _text(item.get("participantId"), 100), _text(item.get("participantName"), 120),
         _phone_like(item.get("participantPhoneNumber")) or _phone_like(item.get("participantUsername"))))
    row = connection.execute("SELECT * FROM chat_conversation WHERE account_id = ? AND remote_id = ?", (account["id"], remote_id)).fetchone()
    return row, parse_moment(item.get("updatedTime"))


def _changed(row: sqlite3.Row, updated: datetime | None, cutoff: datetime) -> bool:
    if row["synced_at"] is None:
        return updated is None or updated >= cutoff
    stored = parse_moment(row["updated_time"])
    return updated is not None and (stored is None or updated > stored)


def _keep(connection: sqlite3.Connection, conversation_id: int, items: list[dict], cutoff: datetime, stop_at_known: bool) -> tuple[int, bool]:
    """Inserts a page of messages (newest first); returns how many were new and whether the page reached what is
    older than the cutoff or, with `stop_at_known`, what was already kept (so there is no need to look further back)."""
    added, reached = 0, False
    with transaction(connection):
        for item in items:
            fields = message_fields(item)
            if fields is None:
                continue
            sent = parse_moment(fields["sent_at"])
            if sent is not None and sent < cutoff:
                reached = True
                continue
            new = connection.execute(
                """INSERT OR IGNORE INTO chat_message (conversation_id, remote_id, direction, sender_name, body, unsupported, attachments, source, sent_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (conversation_id, fields["remote_id"], fields["direction"], fields["sender_name"], fields["body"], fields["unsupported"],
                 fields["attachments"], fields["source"], fields["sent_at"], now())).rowcount
            added += new
            reached = reached or (stop_at_known and not new)
            if fields["direction"] == "incoming" and fields["phone"]:
                connection.execute("UPDATE chat_conversation SET participant_phone = coalesce(participant_phone, ?) WHERE id = ?", (fields["phone"], conversation_id))
    return added, reached


def _walk(connection: sqlite3.Connection, key: str, client: httpx.Client, account: sqlite3.Row, row: sqlite3.Row, cutoff: datetime,
          cursor: str | None, head: bool, pages: int, late) -> dict:
    """Reads a conversation's messages newest first from `cursor`, at most `pages` pages. The head pass (from the
    newest) stops at the first message already kept; a backfill pass does not, because between its cursor and the
    cutoff there may be a gap of any size. Returns {"added", "used", "done", "cursor" (where to go on), "failed"}."""
    walked = {"added": 0, "used": 0, "done": False, "cursor": cursor, "failed": None}
    while walked["used"] < pages and not late():
        try:
            items, following = zernio.messages(key, account["remote_id"], row["remote_id"], walked["cursor"], client)
        except zernio.ZernioError as error:
            if error.status != "error":
                raise
            walked["failed"] = error
            return walked
        walked["used"] += 1
        added, reached = _keep(connection, row["id"], items, cutoff, stop_at_known=head)
        walked["added"] += added
        if reached or not following:
            walked.update(done=True, cursor=None)
            return walked
        walked["cursor"] = following
    return walked


def _read_conversation(connection: sqlite3.Connection, key: str, client: httpx.Client, account: sqlite3.Row, row: sqlite3.Row,
                       updated: datetime | None, cutoff: datetime, head: bool, late, result: dict) -> bool:
    """Reads what is new in one conversation and goes on with its older messages. Returns False when no request
    could be made (out of time); the conversation is then left exactly as it was."""
    pages, backfill, stamp, touched, failed = MAX_MESSAGE_PAGES, row["backfill_cursor"], False, False, None
    if head:
        walked = _walk(connection, key, client, account, row, cutoff, None, True, pages, late)
        result["added"] += walked["added"]
        pages -= walked["used"]
        failed = walked["failed"]
        if walked["used"]:
            touched = stamp = True  # what is new is in; anything not reached goes on as backfill
            if not walked["done"]:
                # From a newer cursor, a backfill that does not stop at kept messages also covers any older gap.
                backfill = walked["cursor"]
    if backfill and pages > 0 and failed is None:
        walked = _walk(connection, key, client, account, row, cutoff, backfill, False, pages, late)
        result["added"] += walked["added"]
        touched = touched or walked["used"] > 0
        failed = walked["failed"]
        backfill = None if walked["done"] else walked["cursor"]
    if failed is not None:
        result["skipped"] += 1
    if not touched:
        return failed is not None
    connection.execute(
        """UPDATE chat_conversation SET backfill_cursor = ?,
             updated_time = CASE WHEN ? THEN ? ELSE updated_time END, synced_at = CASE WHEN ? THEN ? ELSE synced_at END,
             last_incoming_at = (SELECT max(sent_at) FROM chat_message WHERE conversation_id = ? AND direction = 'incoming') WHERE id = ?""",
        (backfill, stamp, updated.strftime("%Y-%m-%dT%H:%M:%SZ") if updated else None, stamp, now(), row["id"], row["id"]))
    result["read"] += 1
    if backfill:
        result["pending"] += 1
    return True


def sync(connection: sqlite3.Connection, key: str | None, client: httpx.Client | None = None, seconds: float = BUDGET) -> dict:
    """One reading of every enabled WhatsApp account. Returns {"status", "added", "read", "pending", "skipped",
    "accounts", "error"}; failures are recorded on the accounts with a message for the user and never raise. Two
    readings never run at once ("busy")."""
    if not _LOCK.acquire(blocking=False):
        return {"status": "busy", "added": 0, "read": 0, "pending": 0, "skipped": 0, "accounts": 0, "error": None}
    own = client is None
    client = client or httpx.Client()
    try:
        result = _sync(connection, key, client, seconds)
        _remember(connection, result)
        return result
    finally:
        if own:
            client.close()
        _LOCK.release()


def _sync(connection: sqlite3.Connection, key: str | None, client: httpx.Client, seconds: float) -> dict:
    began = _clock()
    late = lambda: _clock() - began + REQUEST_MARGIN > seconds  # noqa: E731
    result = {"status": "ok", "added": 0, "read": 0, "pending": 0, "skipped": 0, "accounts": 0, "error": None}
    before = _statuses(connection)
    try:
        if not key:
            raise zernio.ZernioError("auth", "Falta la clave de API de Zernio.")
        accounts = _register(connection, zernio.accounts(key, client))
        before = {account_id: status for account_id, status in _statuses(connection).items() if account_id in {a["id"] for a in accounts.values()}}
        result["accounts"] = len(accounts)
        if not accounts:
            return result
        # The accounts and the first page are always asked for; further pages only while there is time.
        listed, cursor = [], None
        for _ in range(MAX_CONVERSATION_PAGES):
            page, cursor = zernio.conversations(key, cursor, client)
            listed += page
            if not cursor or late():
                break
        wanted = []
        with transaction(connection):
            for item in listed:
                account = accounts.get(str(item.get("accountId") or ""))
                kept = _conversation(connection, account, item) if account else None
                if kept is None:
                    continue
                row, updated = kept
                cutoff = datetime.now(UTC) - timedelta(days=account["max_age_days"])
                head = _changed(row, updated, cutoff)
                if head or row["backfill_cursor"]:
                    wanted.append((updated, row, account, cutoff, head))
        oldest = datetime.min.replace(tzinfo=UTC)
        wanted.sort(key=lambda w: w[0] or oldest, reverse=True)  # the most recent conversations first
        for index, (updated, row, account, cutoff, head) in enumerate(wanted):
            if not _read_conversation(connection, key, client, account, row, updated, cutoff, head, late, result):
                result["pending"] += len(wanted) - index  # out of time: the rest, untouched, in the next reading
                break
        _mark(connection, before, "ok", None)
        return result
    except zernio.ZernioError as error:
        _mark(connection, before, error.status, str(error))
        return {**result, "status": error.status, "error": str(error)}
    except Exception as error:  # noqa: BLE001 - recorded on the accounts, never raised
        message = f"Error inesperado al leer WhatsApp ({type(error).__name__}); se reintentará."
        _mark(connection, before, "error", message)
        return {**result, "status": "error", "error": message}


def chat_worker(settings, secrets, stop: threading.Event) -> None:
    """Reads WhatsApp every five minutes while there is a key (without one, no request reaches Zernio)."""
    if stop.wait(20):  # a short pause so start-up is not slowed down
        return
    while True:
        try:
            key = secrets.get(zernio.SECRET)
            if key:
                connection = connect(settings.data_dir / DB_NAME)
                try:
                    sync(connection, key)
                finally:
                    connection.close()
        except Exception as error:  # a failed round must not stop the core; the next one retries
            print(f"AgoraOne núcleo: no se pudo leer WhatsApp ({type(error).__name__}).", file=sys.stderr)
        if stop.wait(SYNC_SECONDS):
            return
