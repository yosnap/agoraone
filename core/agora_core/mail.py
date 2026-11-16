"""Mail accounts and their read-only synchronisation (user's decision, 14/11/2026).

The mailbox is opened with EXAMINE (read-only) and messages are fetched with BODY.PEEK, so nothing is
marked as read, moved or deleted. Each run takes only what is new (UIDVALIDITY + last UID), at most
`BATCH` messages, oldest first, so a large mailbox fills in over several runs. Passwords come from the
Keychain and never appear in errors, logs or answers.
"""

import imaplib
import json
import socket
import sqlite3
import ssl
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .db import now
from .mail_parse import parse

FOLDER = "INBOX"
BATCH = 200
MANUAL_BATCH = 40  # «Leer ahora» answers within the backend's time limit; the rest comes in the background
RESEND_BATCH = 25  # Resend asks for pauses between requests: fewer per reading
# A first read of a large mailbox answers SEARCH with one very long line; imaplib's default cap is 1 MB.
imaplib._MAXLINE = 20_000_000
MAX_MESSAGE = 15 * 1024 * 1024
TIMEOUT = 30
LEVELS = ("normal", "local_only", "private")


@dataclass(frozen=True)
class Preset:
    name: str
    imap: tuple[str, int]
    smtp: tuple[str, int]
    hint: str


# Providers with their own setup; any other server is entered by hand ("other"). Microsoft signs in with
# OAuth (it no longer accepts app passwords for IMAP): stored as an "other" server with auth = 'microsoft'.
PRESETS = {
    "gmail": Preset("Gmail / Google Workspace", ("imap.gmail.com", 993), ("smtp.gmail.com", 465),
                    "Necesita la verificación en dos pasos y una contraseña de aplicación (myaccount.google.com/apppasswords)."),
    "icloud": Preset("iCloud", ("imap.mail.me.com", 993), ("smtp.mail.me.com", 587),
                     "Usuario: tu dirección de iCloud. Contraseña de aplicación desde account.apple.com."),
    "microsoft": Preset("Microsoft (Outlook, Hotmail, Microsoft 365)", ("outlook.office365.com", 993), ("smtp.office365.com", 587),
                        "Se conecta con tu cuenta de Microsoft, sin contraseña de aplicación: AgoraOne te dará un código para microsoft.com/devicelogin."),
    # Namecheap, Hostinger and any hosting with its own domain are plain IMAP/SMTP: their servers go here.
    "other": Preset("Otro servidor (IMAP)", ("", 993), ("", 465),
                    "Los servidores IMAP y SMTP de tu proveedor (en Namecheap, mail.privateemail.com; en Hostinger, imap/smtp.hostinger.com). Usuario: la dirección completa."),
    # Only sending: no mailbox to read.
    "resend": Preset("Resend (envío y recepción)", ("", 0), ("smtp.resend.com", 465),
                     "Envía por el SMTP de Resend y, si lo marcas, lee lo que recibes con su API (no tiene IMAP). La dirección tiene que ser de un dominio verificado en Resend. Contraseña: tu clave de API (empieza por «re_»; para leer, con «Full access»)."),
    "smtp": Preset("Solo envío por SMTP (SendGrid, Mailgun, Brevo…)", ("", 0), ("", 465),
                   "Solo envía, no lee correo: el servidor SMTP, el puerto (465 o 587), el usuario y la contraseña o clave que te dé el servicio."),
}
SEND_ONLY = {"resend": "resend", "smtp": "smtp"}  # presets without IMAP, and their fixed username (Resend's is «resend»)


class MailError(ValueError):
    pass


def secret_account(account_id: int) -> str:
    return f"mail:{account_id}"


def _scope_exists(connection: sqlite3.Connection, scope_id) -> None:
    if scope_id is not None and not connection.execute("SELECT 1 FROM scope WHERE id = ?", (scope_id,)).fetchone():
        raise MailError("Ese ámbito no existe.")


def _username(value) -> str:
    name = str(value or "").strip()
    if not name or len(name) > 254 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in name):
        raise MailError("Usuario no válido: sin espacios ni saltos de línea.")
    return name


def _host(value) -> str | None:
    if value is None:
        return None
    host = str(value).strip().lower()
    if not host or len(host) > 253 or any(c.isspace() or c in "/:@" for c in host):
        raise MailError("Servidor no válido: escribe solo el nombre, sin puerto ni «https://».")
    return host


def create_account(connection: sqlite3.Connection, data: dict) -> int:
    provider = data.get("provider", "other")
    if provider not in PRESETS:
        raise MailError("Proveedor desconocido.")
    preset = PRESETS[provider]
    address = str(data.get("address", "")).strip().lower()
    if "@" not in address or len(address) > 254 or any(c.isspace() for c in address):
        raise MailError("Escribe una dirección de correo válida.")
    if provider in SEND_ONLY:
        return _create_sender(connection, provider, preset, address, data)
    imap_host = _host(data.get("imapHost")) or preset.imap[0]
    if not imap_host:
        raise MailError("Falta el servidor IMAP.")
    level = data.get("confidentiality", "normal")
    if level not in LEVELS:
        raise MailError("Nivel de confidencialidad no válido.")
    _scope_exists(connection, data.get("scopeId"))
    microsoft = provider == "microsoft"
    try:
        cursor = connection.execute(
            """INSERT INTO mail_account (address, label, provider, username, imap_host, imap_port, smtp_host, smtp_port,
               scope_id, confidentiality, max_age_days, created_at, auth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (address, data.get("label") or None, "other" if microsoft else provider,
             address if microsoft else _username(data.get("username") or address), imap_host,
             int(data.get("imapPort") or preset.imap[1]), _host(data.get("smtpHost")) or preset.smtp[0] or None,
             int(data.get("smtpPort") or preset.smtp[1]), data.get("scopeId"), level, int(data.get("maxAgeDays") or 60), now(),
             "microsoft" if microsoft else "password"),
        )
    except sqlite3.IntegrityError as error:
        if "UNIQUE" in str(error):
            raise MailError("Esa cuenta ya está conectada.") from error
        raise MailError("Algún dato de la cuenta no es válido.") from error
    return cursor.lastrowid


def _port(value, default: int) -> int:
    try:
        port = int(value if value is not None else default)
    except (TypeError, ValueError) as error:
        raise MailError("Puerto no válido.") from error
    if not 1 <= port <= 65535:
        raise MailError("Puerto no válido.")
    return port


def _create_sender(connection: sqlite3.Connection, provider: str, preset: Preset, address: str, data: dict) -> int:
    """An account that only sends: its SMTP server, port and username; never read."""
    smtp_host = _host(data.get("smtpHost")) or preset.smtp[0]
    if not smtp_host:
        raise MailError("Falta el servidor SMTP.")
    smtp_port = _port(data.get("smtpPort"), preset.smtp[1])
    inbound = 1 if provider == "resend" and data.get("inbound", True) else 0
    username = _username(data.get("username") or ("resend" if provider == "resend" else address))
    level = data.get("confidentiality", "normal")
    if level not in LEVELS:
        raise MailError("Nivel de confidencialidad no válido.")
    _scope_exists(connection, data.get("scopeId"))
    try:
        return connection.execute(
            """INSERT INTO mail_account (address, label, provider, username, imap_host, imap_port, smtp_host, smtp_port,
               scope_id, confidentiality, max_age_days, created_at, auth, kind, inbound) VALUES (?, ?, 'other', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'password', 'send', ?)""",
            (address, data.get("label") or None, username, smtp_host, smtp_port, smtp_host, smtp_port, data.get("scopeId"), level,
             int(data.get("maxAgeDays") or 60), now(), inbound),
        ).lastrowid
    except sqlite3.IntegrityError as error:
        if "UNIQUE" in str(error):
            raise MailError("Esa cuenta ya está conectada.") from error
        raise MailError("Algún dato de la cuenta no es válido.") from error


_EDITABLE = {"label": "label", "username": "username", "imapHost": "imap_host", "imapPort": "imap_port", "smtpHost": "smtp_host",
             "smtpPort": "smtp_port", "scopeId": "scope_id", "confidentiality": "confidentiality", "maxAgeDays": "max_age_days",
             "enabled": "enabled", "inbound": "inbound"}


_REQUIRED = {"username", "imapHost", "imapPort", "maxAgeDays", "enabled", "confidentiality"}


def update_account(connection: sqlite3.Connection, account_id: int, changes: dict) -> None:
    """Applies every change or none (one transaction); fields that cannot be empty refuse null."""
    if not connection.execute("SELECT 1 FROM mail_account WHERE id = ?", (account_id,)).fetchone():
        raise MailError("Esa cuenta no existe.")
    if any(changes.get(key, "") is None for key in _REQUIRED):
        raise MailError("Falta un dato obligatorio de la cuenta.")
    if "scopeId" in changes:
        _scope_exists(connection, changes["scopeId"])
    if changes.get("confidentiality", "normal") not in LEVELS:
        raise MailError("Nivel de confidencialidad no válido.")
    current = connection.execute("SELECT kind, smtp_host FROM mail_account WHERE id = ?", (account_id,)).fetchone()
    send_only = current["kind"] == "send"
    if changes.get("inbound") and current["smtp_host"] != "smtp.resend.com":
        raise MailError("Solo las cuentas de Resend leen lo recibido por su API.")
    if send_only and changes.get("smtpHost", "") is None:
        raise MailError("Falta el servidor SMTP.")
    values = {}
    for key, column in _EDITABLE.items():
        if key in changes:
            value = changes[key]
            if key in ("imapHost", "smtpHost"):
                value = _host(value)
            elif key in ("imapPort", "smtpPort") and value is not None:
                value = _port(value, 0)
            elif key == "username":
                value = _username(value)
            elif key in ("enabled", "inbound"):
                value = 1 if value else 0
            values[column] = value
    if send_only:  # its placeholder IMAP columns follow the SMTP server; nothing reads them
        values.pop("imap_host", None), values.pop("imap_port", None)
        if "smtp_host" in values:
            values["imap_host"] = values["smtp_host"]
    if {"username", "imapHost", "imapPort", "smtpHost", "smtpPort"} & changes.keys():
        values.update(status="pending", last_error=None)
    if not values:
        return
    connection.execute("BEGIN IMMEDIATE")
    try:
        for column, value in values.items():
            connection.execute(f"UPDATE mail_account SET {column} = ? WHERE id = ?", (value, account_id))
        connection.execute("COMMIT")
    except sqlite3.IntegrityError as error:
        connection.execute("ROLLBACK")
        raise MailError("Algún dato de la cuenta no es válido.") from error


def delete_account(connection: sqlite3.Connection, account_id: int) -> bool:
    return connection.execute("DELETE FROM mail_account WHERE id = ?", (account_id,)).rowcount > 0


def list_accounts(connection: sqlite3.Connection, has_password: Callable[[int], bool]) -> list[dict]:
    rows = connection.execute(
        """SELECT a.*, s.name AS scope_name, (SELECT count(*) FROM mail_message m WHERE m.account_id = a.id) AS messages
           FROM mail_account a LEFT JOIN scope s ON s.id = a.scope_id ORDER BY a.address"""
    ).fetchall()
    return [{
        "id": r["id"], "address": r["address"], "label": r["label"], "kind": r["kind"], "inbound": bool(r["inbound"]),
        "provider": "microsoft" if r["auth"] == "microsoft" else ("resend" if (r["smtp_host"] or "") == "smtp.resend.com" else "smtp") if r["kind"] == "send" else r["provider"],
        "auth": r["auth"], "username": r["username"],
        "imapHost": r["imap_host"], "imapPort": r["imap_port"], "smtpHost": r["smtp_host"], "smtpPort": r["smtp_port"],
        "scopeId": r["scope_id"], "scopeName": r["scope_name"], "confidentiality": r["confidentiality"],
        "maxAgeDays": r["max_age_days"], "enabled": bool(r["enabled"]), "status": r["status"], "lastError": r["last_error"],
        "lastSyncAt": r["last_sync_at"], "messages": r["messages"], "hasPassword": has_password(r["id"]),
    } for r in rows]


# --- IMAP -------------------------------------------------------------------------------------------

def open_imap(host: str, port: int):
    return imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=TIMEOUT)


def _fetched(data) -> list[tuple[bytes, bytes | None]]:
    """(metadata line, literal) pairs of an imaplib FETCH answer; the closing b')' items are dropped."""
    return [(item[0], item[1]) if isinstance(item, tuple) else (item, None) for item in data or [] if item and item != b")"]


def _uid_of(meta: bytes) -> int | None:
    parts = meta.replace(b"(", b" ").replace(b")", b" ").split()
    for index, token in enumerate(parts[:-1]):
        if token.upper() == b"UID" and parts[index + 1].isdigit():
            return int(parts[index + 1])
    return None


def _size_of(meta: bytes) -> int:
    parts = meta.replace(b"(", b" ").replace(b")", b" ").split()
    for index, token in enumerate(parts[:-1]):
        if token.upper() == b"RFC822.SIZE" and parts[index + 1].isdigit():
            return int(parts[index + 1])
    return 0


def _store(connection: sqlite3.Connection, account_id: int, uidvalidity: int, uid: int, raw: bytes | None, size: int, folder: str = FOLDER) -> None:
    columns = dict(message_id=None, in_reply_to=None, from_address=None, from_name=None, to_addresses="[]", cc_addresses="[]",
                   subject=None, sent_at=None, body=None, truncated=1, attachments="[]")
    try:
        parsed = parse(raw) if raw is not None else None
    except Exception:  # unreadable even for the lenient parser: kept as an empty, truncated entry
        parsed = None
    if parsed is not None:
        columns.update(
            message_id=parsed.message_id, in_reply_to=parsed.in_reply_to, from_address=parsed.from_address,
            from_name=parsed.from_name, to_addresses=json.dumps(parsed.to_addresses), cc_addresses=json.dumps(parsed.cc_addresses),
            subject=parsed.subject, sent_at=parsed.sent_at, body=parsed.body if size <= MAX_MESSAGE else None,
            truncated=1 if parsed.truncated or size > MAX_MESSAGE else 0, attachments=json.dumps(parsed.attachments),
        )
    connection.execute(
        f"""INSERT OR IGNORE INTO mail_message (account_id, folder, uidvalidity, uid, {", ".join(columns)}, bytes, received_at)
            VALUES (?, ?, ?, ?, {", ".join("?" * len(columns))}, ?, ?)""",
        (account_id, folder, uidvalidity, uid, *columns.values(), size, now()),
    )


def _status(connection: sqlite3.Connection, account_id: int, status: str, error: str | None) -> None:
    connection.execute("UPDATE mail_account SET status = ?, last_error = ?, last_sync_at = ? WHERE id = ?",
                       (status, error, now(), account_id))


_LOCKS: dict[int, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def sync_account(connection: sqlite3.Connection, account_id: int, password: str | None, opener=open_imap, batch: int = BATCH, login=None) -> dict:
    """Reads what is new in the account's inbox. Returns {"status", "added"}; failures are recorded on the
    account with a message for the user and never raise. `login(client, account, secret)` signs in when the
    account does not use a plain password (Microsoft's XOAUTH2); it raises LoginError with the reason."""
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(account_id, threading.Lock())
    if not lock.acquire(blocking=False):
        return {"status": "busy", "added": 0}
    try:
        return _sync(connection, account_id, password, opener, batch, login)
    finally:
        lock.release()


def _sync_resend(connection: sqlite3.Connection, account: sqlite3.Row, key: str | None, batch: int) -> dict:
    """What arrived through Resend Inbound, read with its API (Resend has no IMAP)."""
    from . import resend_inbound

    if not key:
        _status(connection, account["id"], "auth", "Falta la clave de API de Resend.")
        return {"status": "auth", "added": 0}
    try:
        added = resend_inbound.sync(connection, account, key, _store, MAX_MESSAGE, min(batch, RESEND_BATCH))
    except resend_inbound.InboundError as error:
        if error.status == "auth" and "Full access" in str(error):
            # A sending key: sending still works, so reading is turned off and said, instead of a red account.
            connection.execute("UPDATE mail_account SET inbound = 0, last_error = ? WHERE id = ?",
                               (f"{error} Se ha desmarcado «Leer también lo que recibes».", account["id"]))
            return {"status": "auth", "added": 0}
        _status(connection, account["id"], error.status, str(error))
        return {"status": error.status, "added": 0}
    except Exception as error:  # noqa: BLE001 - recorded on the account, never raised
        _status(connection, account["id"], "error", f"Error inesperado al leer Resend ({type(error).__name__}).")
        return {"status": "error", "added": 0}
    _status(connection, account["id"], "ok", None)
    return {"status": "ok", "added": added}


class LoginError(RuntimeError):
    """A sign-in that could not even be attempted (an expired Microsoft permission, a missing client id)."""


def _sync(connection: sqlite3.Connection, account_id: int, password: str | None, opener, batch: int, login) -> dict:
    account = connection.execute("SELECT * FROM mail_account WHERE id = ?", (account_id,)).fetchone()
    if account is None:
        return {"status": "missing", "added": 0}
    if account["kind"] == "send":
        if not (account["inbound"] and account["smtp_host"] == "smtp.resend.com"):
            return {"status": "send", "added": 0}  # no mailbox: nothing to read
        return _sync_resend(connection, account, password, batch)
    if not password:
        _status(connection, account_id, "auth", "Falta conectar la cuenta con Microsoft." if account["auth"] == "microsoft"
                else "Falta la contraseña de aplicación de esta cuenta.")
        return {"status": "auth", "added": 0}
    try:
        client = opener(account["imap_host"], account["imap_port"])
    except (OSError, socket.timeout, ssl.SSLError):
        _status(connection, account_id, "unreachable", f"No se pudo conectar con {account['imap_host']}:{account['imap_port']}.")
        return {"status": "unreachable", "added": 0}
    try:
        try:
            if account["auth"] == "microsoft":
                if login is None:
                    raise LoginError("Falta el identificador de la aplicación de Microsoft en Ajustes.")
                login(client, account, password)
            else:
                client.login(account["username"], password)
        except LoginError as error:
            _status(connection, account_id, "auth", str(error))
            return {"status": "auth", "added": 0}
        except imaplib.IMAP4.error:
            _status(connection, account_id, "auth", "El servidor rechazó el usuario o la contraseña de aplicación.")
            return {"status": "auth", "added": 0}
        except UnicodeEncodeError:
            _status(connection, account_id, "auth", "El usuario o la contraseña llevan letras que este servidor no acepta (tildes, «ñ», «€»).")
            return {"status": "auth", "added": 0}
        added = _read_inbox(connection, account, client, batch)
        _status(connection, account_id, "ok", None)
        return {"status": "ok", "added": added}
    except (OSError, socket.timeout, ssl.SSLError):
        _status(connection, account_id, "unreachable", "Se cortó la conexión con el servidor; se reintentará.")
        return {"status": "unreachable", "added": 0}
    except imaplib.IMAP4.error as error:
        _status(connection, account_id, "error", f"El servidor respondió con un error: {str(error)[:200]}")
        return {"status": "error", "added": 0}
    except Exception as error:  # anything unexpected is recorded, never left as a silent stall
        try:
            _status(connection, account_id, "error", f"Error inesperado al leer el correo ({type(error).__name__}); se reintentará.")
        except sqlite3.Error:  # the account was removed meanwhile
            pass
        return {"status": "error", "added": 0}
    finally:
        try:
            client.logout()
        except Exception:
            pass


def _read_inbox(connection: sqlite3.Connection, account: sqlite3.Row, client, batch: int) -> int:
    typ, _ = client.select(FOLDER, readonly=True)  # EXAMINE: nothing in the mailbox changes
    if typ != "OK":
        raise imaplib.IMAP4.error("no se pudo abrir la bandeja de entrada")
    validity = client.response("UIDVALIDITY")[1]
    uidvalidity = int(validity[0]) if validity and validity[0] else 0
    state = connection.execute("SELECT uidvalidity, last_uid FROM mail_folder_state WHERE account_id = ? AND folder = ?",
                               (account["id"], FOLDER)).fetchone()
    if state is None or state["uidvalidity"] != uidvalidity:
        # A new mailbox, or the server renumbered it: what was kept no longer matches its UIDs.
        connection.execute("DELETE FROM mail_message WHERE account_id = ? AND folder = ?", (account["id"], FOLDER))
        connection.execute("INSERT OR REPLACE INTO mail_folder_state (account_id, folder, uidvalidity, last_uid) VALUES (?, ?, ?, 0)",
                           (account["id"], FOLDER, uidvalidity))
        last_uid = 0
    else:
        last_uid = state["last_uid"]
    if last_uid == 0:
        since = (datetime.now(UTC) - timedelta(days=account["max_age_days"])).strftime("%d-%b-%Y")
        typ, data = client.uid("SEARCH", None, "SINCE", since)
    else:
        typ, data = client.uid("SEARCH", None, "UID", f"{last_uid + 1}:*")
    if typ != "OK":
        raise imaplib.IMAP4.error("la búsqueda de correos nuevos falló")
    found = sorted(int(n) for n in (data[0] or b"").split() if n.isdigit()) if data else []
    pending = [uid for uid in found if uid > last_uid][:batch]
    if not pending:
        return 0
    typ, data = client.uid("FETCH", ",".join(map(str, pending)), "(UID RFC822.SIZE)")
    if typ != "OK":
        raise imaplib.IMAP4.error("no se pudo consultar el tamaño de los correos")
    sizes = {uid: _size_of(meta) for meta, _ in _fetched(data) if (uid := _uid_of(meta))}
    added = 0
    for uid in pending:
        size = sizes.get(uid)
        if size is None or size == 0:
            part = f"BODY.PEEK[]<0.{MAX_MESSAGE}>"  # size unknown: never more than the limit
        else:
            part = "BODY.PEEK[]" if size <= MAX_MESSAGE else "BODY.PEEK[HEADER]"
        typ, data = client.uid("FETCH", str(uid), f"(UID {part})")
        if typ != "OK":
            raise imaplib.IMAP4.error("el servidor no entregó un correo; se reintentará")
        # OK without the message: it was deleted meanwhile, so it is skipped.
        raw = next((literal for meta, literal in _fetched(data) if literal is not None and _uid_of(meta) in (uid, None)), None)
        size = size or (len(raw) if raw is not None else 0)
        connection.execute("BEGIN IMMEDIATE")
        try:
            if raw is not None:
                _store(connection, account["id"], uidvalidity, uid, raw, size)
                added += 1
            connection.execute("UPDATE mail_folder_state SET last_uid = ? WHERE account_id = ? AND folder = ?",
                               (uid, account["id"], FOLDER))
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
    return added


def fetch_raw(connection: sqlite3.Connection, message_id: int, password: str | None, opener=open_imap, login=None) -> bytes:
    """The whole stored message again from its server, read-only (EXAMINE and BODY.PEEK), for an attachment
    the user asked for. Raises MailError with a plain reason when it is no longer there."""
    row = connection.execute(
        "SELECT m.uid, m.uidvalidity, m.folder, a.* FROM mail_message m JOIN mail_account a ON a.id = m.account_id WHERE m.id = ?",
        (message_id,),
    ).fetchone()
    if row is None:
        raise MailError("Ese correo ya no está guardado.")
    if not password:
        raise MailError("Falta la contraseña o la conexión de esa cuenta.")
    if row["folder"] == "RESEND":
        from . import resend_inbound
        try:
            return resend_inbound.fetch_raw(connection, row["id"], row["uid"], password, MAX_MESSAGE)
        except resend_inbound.InboundError as error:
            raise MailError(str(error)) from error
    try:
        client = opener(row["imap_host"], row["imap_port"])
    except (OSError, socket.timeout, ssl.SSLError) as error:
        raise MailError(f"No se pudo conectar con {row['imap_host']}.") from error
    try:
        if row["auth"] == "microsoft":
            if login is None:
                raise MailError("Falta el identificador de la aplicación de Microsoft en Ajustes.")
            login(client, row, password)
        else:
            client.login(row["username"], password)
        typ, _ = client.select(row["folder"], readonly=True)
        validity = client.response("UIDVALIDITY")[1]
        if typ != "OK" or not validity or int(validity[0]) != row["uidvalidity"]:
            raise MailError("El buzón cambió desde que se leyó este correo.")
        typ, data = client.uid("FETCH", str(row["uid"]), f"(UID BODY.PEEK[]<0.{MAX_MESSAGE}>)")
        raw = next((literal for meta, literal in _fetched(data) if literal is not None), None) if typ == "OK" else None
        if raw is None:
            raise MailError("El correo ya no está en el servidor.")
        return raw
    except (imaplib.IMAP4.error, LoginError, OSError) as error:
        raise MailError("El servidor no entregó el correo; inténtalo más tarde.") from error
    finally:
        try:
            client.logout()
        except Exception:
            pass
