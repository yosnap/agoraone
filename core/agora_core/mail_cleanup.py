"""Tidying the mailbox (1.7, decision of 15/11/2026): the inbox messages that match what the user asked Watson for
(a sender, a kind, a subject, older than some days) are listed, and only the ones the user approves are moved to
the account's archive or to its trash. Never deleted for good, never marked as read, never anything not on the
approved list, and only when the mailbox was not renumbered since it was read (UIDVALIDITY)."""

import imaplib
import re
import sqlite3
from datetime import UTC, datetime, timedelta

from . import mail
from .db import now, transaction

KINDS = {"factura": "invoice", "pago": "payment", "trabajo": "job", "cliente": "client", "incidencia": "incident", "cita": "appointment",
         "personal": "personal", "importante": "important", "publicidad": "advertising", "otro": "other"}
ACTIONS = {"archivar": "archive", "papelera": "trash"}
MAX = 200


class CleanupError(RuntimeError):
    pass


def candidates(connection: sqlite3.Connection, sender: str = "", kind: str = "", subject: str = "", older_days: int | None = None,
               account: str = "", limit: int = MAX) -> list[dict]:
    """The inbox messages still there (not moved) that match everything given; at least one condition."""
    if not any((sender, kind, subject, older_days)):
        raise CleanupError("Di qué correos: de quién, de qué tipo, con qué asunto o de hace cuánto.")
    where, args = ["m.folder = 'INBOX'", "m.moved IS NULL"], []
    if sender:
        where.append("(lower(m.from_address) LIKE ? OR lower(m.from_name) LIKE ?)")
        args += [f"%{sender.lower()}%"] * 2
    if kind:
        if kind not in KINDS:
            raise CleanupError("Tipo de correo no reconocido.")
        where.append("s.kind = ?")
        args.append(KINDS[kind])
    if subject:
        where.append("lower(m.subject) LIKE ?")
        args.append(f"%{subject.lower()}%")
    if older_days:
        where.append("m.sent_at < ?")
        args.append((datetime.now(UTC) - timedelta(days=int(older_days))).strftime("%Y-%m-%dT%H:%M:%SZ"))
    if account:
        where.append("(lower(coalesce(a.label, '')) LIKE ? OR lower(a.address) LIKE ?)")
        args += [f"%{account.lower()}%"] * 2
    rows = connection.execute(f"""SELECT m.id, m.from_address, m.from_name, m.subject, m.sent_at, coalesce(a.label, a.address) AS account,
                                         CASE WHEN 'private' IN (coalesce(s.confidentiality, ''), a.confidentiality) THEN 'private'
                                              WHEN 'local_only' IN (coalesce(s.confidentiality, ''), a.confidentiality) THEN 'local_only' ELSE 'normal' END AS confidentiality
                                  FROM mail_message m JOIN mail_account a ON a.id = m.account_id LEFT JOIN mail_summary s ON s.message_id = m.id
                                  WHERE {' AND '.join(where)} ORDER BY m.sent_at DESC LIMIT ?""", (*args, min(limit, MAX))).fetchall()
    return [{"id": r["id"], "from": r["from_name"] or r["from_address"] or "", "address": r["from_address"] or "", "subject": r["subject"] or "(sin asunto)",
             "date": r["sent_at"], "account": r["account"], "level": r["confidentiality"] or "normal"} for r in rows]


def _mailbox_for(client, action: str) -> str | None:
    """The account's own archive or trash, by the special-use flags the server sets (RFC 6154). For Gmail,
    archiving is moving to «All Mail» (\\All), which takes the message out of the inbox."""
    typ, lines = client.list()
    if typ != "OK":
        return None
    wanted = ("\\Trash",) if action == "trash" else ("\\Archive", "\\All")
    found: dict[str, str] = {}
    for line in lines or []:
        text = line.decode("utf-8", "replace") if isinstance(line, bytes) else str(line)
        match = re.match(r'\((?P<flags>[^)]*)\)\s+(?:"[^"]*"|NIL)\s+(?P<name>.+)$', text)
        if not match:
            continue
        for flag in wanted:
            if flag.lower() in match["flags"].lower() and flag not in found:
                found[flag] = match["name"].strip()
    return next((found[f] for f in wanted if f in found), None)


def move(connection: sqlite3.Connection, ids: list[int], action: str, password_of, login=None, opener=mail.open_imap) -> dict:
    """Moves these inbox messages to their account's archive or trash. Per account: the same mailbox it read
    (UIDVALIDITY), MOVE when the server has it, else COPY and UID EXPUNGE of exactly those (never a plain EXPUNGE)."""
    if action not in ("archive", "trash"):
        raise CleanupError("Acción no admitida.")
    rows = connection.execute(f"SELECT * FROM mail_message WHERE id IN ({','.join('?' * len(ids))}) AND folder = 'INBOX' AND moved IS NULL",
                              ids).fetchall() if ids else []
    by_account: dict[int, list[sqlite3.Row]] = {}
    for row in rows:
        by_account.setdefault(row["account_id"], []).append(row)
    done, problems = 0, []
    for account_id, messages in by_account.items():
        account = connection.execute("SELECT * FROM mail_account WHERE id = ?", (account_id,)).fetchone()
        try:
            moved = _move_account(account, messages, action, password_of(account_id), login, opener)
        except (CleanupError, mail.LoginError, imaplib.IMAP4.error, OSError) as error:
            problems.append(f"{account['label'] or account['address']}: {error if isinstance(error, (CleanupError, mail.LoginError)) else 'el servidor no lo permitió'}")
            continue
        with transaction(connection):
            for row in [m for m in messages if m["uid"] in moved]:
                connection.execute("UPDATE mail_message SET moved = ?, moved_at = ? WHERE id = ?", (action, now(), row["id"]))
                connection.execute("UPDATE mail_summary SET state = 'done' WHERE message_id = ? AND state = 'pending'", (row["id"],))
        done += len(moved)
    return {"moved": done, "problems": problems}


def _move_account(account, messages, action: str, password: str | None, login, opener) -> set[int]:
    if not password:
        raise CleanupError("falta la contraseña de aplicación o el permiso de Microsoft")
    client = opener(account["imap_host"], account["imap_port"])
    try:
        if account["auth"] == "microsoft":
            if login is None:
                raise CleanupError("falta el permiso de Microsoft")
            login(client, account, password)
        else:
            client.login(account["username"], password)
        typ, _ = client.select("INBOX")  # read-write: the only time AgoraOne opens it so, for a confirmed move
        if typ != "OK":
            raise CleanupError("no se pudo abrir la bandeja de entrada")
        validity = int((client.untagged_responses.get("UIDVALIDITY") or [b"0"])[0])
        same = [m["uid"] for m in messages if m["uidvalidity"] == validity]
        uids = [str(uid) for uid in same]
        if not uids:
            raise CleanupError("el buzón cambió desde que se leyó: vuelve a pedirlo cuando se actualice")
        target = _mailbox_for(client, action)
        if not target:
            raise CleanupError("el servidor no dice cuál es su carpeta de " + ("Papelera" if action == "trash" else "Archivo"))
        capabilities = {c.upper() for c in client.capabilities}
        uid_set = ",".join(uids)
        if "MOVE" in capabilities:
            typ, _ = client.uid("MOVE", uid_set, target)
        elif "UIDPLUS" in capabilities:
            typ, _ = client.uid("COPY", uid_set, target)
            if typ == "OK":
                client.uid("STORE", uid_set, "+FLAGS.SILENT", "(\\Deleted)")
                typ, _ = client.uid("EXPUNGE", uid_set)
        else:
            raise CleanupError("el servidor no permite mover correos con seguridad")
        if typ != "OK":
            raise CleanupError("el servidor no pudo moverlos")
        return set(same)
    finally:
        try:
            client.logout()
        except Exception:  # noqa: BLE001 - already closed
            pass
