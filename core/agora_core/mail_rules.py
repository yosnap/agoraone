"""The user's rules for incoming mail: a condition (sender address or domain, account, subject, words) and
what it means (supplier invoice, client, personal, important or ignore). Rules win over the automatic
classification; the first enabled rule that matches, oldest first, decides. A rule can only make a
message's confidentiality stricter than its account's, never looser."""

import re
import sqlite3

from .db import now, transaction

ACTIONS = ("invoice", "client", "personal", "important", "ignore")
LEVELS = ("normal", "local_only", "private")
# The kind a message gets when a rule decides it (ignored messages keep the kind found and go quiet).
KIND_OF_ACTION = {"invoice": "invoice", "client": "client", "personal": "personal", "important": "important"}
_FIELDS = {"name": "name", "sender": "sender", "accountId": "account_id", "subject": "subject", "words": "words",
           "action": "action", "scopeId": "scope_id", "confidentiality": "confidentiality", "enabled": "enabled"}
_SENDER = re.compile(r"(?:[^@\s<>\"]+@)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")


class RuleError(ValueError):
    pass


def stricter(a: str, b: str | None) -> str:
    return a if b is None else LEVELS[max(LEVELS.index(a), LEVELS.index(b))]


def _clean(data: dict) -> dict:
    values = {}
    for key, column in _FIELDS.items():
        if key not in data:
            continue
        value = data[key]
        if isinstance(value, str):
            value = re.sub(r"\s+", " ", value).strip() or None
        if key == "sender" and value is not None:
            value = value.lower().lstrip("@")
            if not _SENDER.fullmatch(value):
                raise RuleError("El remitente debe ser una dirección (ana@cliente.com) o un dominio (cliente.com).")
        if key == "action" and value not in ACTIONS:
            raise RuleError("Acción desconocida.")
        if key == "confidentiality" and value is not None and value not in LEVELS:
            raise RuleError("Nivel de confidencialidad desconocido.")
        if key == "enabled":
            value = 1 if value else 0
        values[column] = value
    return values


def _check_refs(connection: sqlite3.Connection, values: dict) -> None:
    if values.get("account_id") is not None and not connection.execute("SELECT 1 FROM mail_account WHERE id = ?", (values["account_id"],)).fetchone():
        raise RuleError("Esa cuenta no existe.")
    if values.get("scope_id") is not None and not connection.execute("SELECT 1 FROM scope WHERE id = ?", (values["scope_id"],)).fetchone():
        raise RuleError("Ese ámbito no existe.")


def create_rule(connection: sqlite3.Connection, data: dict) -> int:
    values = _clean(data)
    if not values.get("name") or not values.get("action"):
        raise RuleError("La regla necesita un nombre y una acción.")
    if not any(values.get(c) is not None for c in ("sender", "account_id", "subject", "words")):
        raise RuleError("La regla necesita al menos una condición: remitente, cuenta, asunto o palabras.")
    _check_refs(connection, values)
    columns = [*values, "created_at"]
    with transaction(connection):
        cursor = connection.execute(
            f"INSERT INTO mail_rule ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
            [*values.values(), now()],
        )
        reapply(connection)
    return cursor.lastrowid


def update_rule(connection: sqlite3.Connection, rule_id: int, changes: dict) -> bool:
    values = _clean(changes)
    if "name" in values and not values["name"] or "action" in values and not values["action"] or "enabled" in changes and changes["enabled"] is None:
        raise RuleError("La regla necesita un nombre y una acción.")
    _check_refs(connection, values)
    with transaction(connection):
        if not connection.execute("SELECT 1 FROM mail_rule WHERE id = ?", (rule_id,)).fetchone():
            return False
        if values:
            try:
                connection.execute(f"UPDATE mail_rule SET {', '.join(f'{c} = ?' for c in values)} WHERE id = ?", [*values.values(), rule_id])
            except sqlite3.IntegrityError as error:
                raise RuleError("La regla necesita al menos una condición: remitente, cuenta, asunto o palabras.") from error
        reapply(connection)
    return True


def delete_rule(connection: sqlite3.Connection, rule_id: int) -> bool:
    with transaction(connection):
        deleted = connection.execute("DELETE FROM mail_rule WHERE id = ?", (rule_id,)).rowcount > 0
        reapply(connection)
    return deleted


def list_rules(connection: sqlite3.Connection) -> list[dict]:
    return [{"id": r["id"], "name": r["name"], "sender": r["sender"], "accountId": r["account_id"], "subject": r["subject"],
             "words": r["words"], "action": r["action"], "scopeId": r["scope_id"], "confidentiality": r["confidentiality"],
             "enabled": bool(r["enabled"])} for r in connection.execute("SELECT * FROM mail_rule ORDER BY id")]


def _sender_matches(rule_sender: str, address: str | None) -> bool:
    if not address:
        return False
    address = address.lower()
    if "@" in rule_sender:
        return address == rule_sender
    domain = address.rsplit("@", 1)[-1]
    return domain == rule_sender or domain.endswith("." + rule_sender)


def matches(rule: sqlite3.Row | dict, message: sqlite3.Row | dict) -> bool:
    if rule["sender"] and not _sender_matches(rule["sender"], message["from_address"]):
        return False
    if rule["account_id"] is not None and rule["account_id"] != message["account_id"]:
        return False
    subject = (message["subject"] or "").casefold()
    if rule["subject"] and rule["subject"].casefold() not in subject:
        return False
    if rule["words"]:
        text = subject + "\n" + (message["body"] or "").casefold()
        words = [w.strip().casefold() for w in rule["words"].split(",") if w.strip()]
        if not any(w in text for w in words):
            return False
    return True


def enabled_rules(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute("SELECT * FROM mail_rule WHERE enabled = 1 ORDER BY id").fetchall()


def first_match(rules: list, message) -> sqlite3.Row | None:
    return next((rule for rule in rules if matches(rule, message)), None)


def reapply(connection: sqlite3.Connection) -> None:
    """Applies the current rules again to what has not been decided yet (pending or quiet messages), without
    calling any model: a new rule takes effect on the Bandeja at once. Decided messages are left alone."""
    rules = enabled_rules(connection)
    rows = connection.execute(
        """SELECT s.message_id, s.kind, s.source, s.rule_id, s.state, s.summary, m.account_id, m.from_address, m.subject,
                  m.body, a.confidentiality AS account_level
           FROM mail_summary s JOIN mail_message m ON m.id = s.message_id JOIN mail_account a ON a.id = m.account_id
           WHERE s.state IN ('pending', 'quiet')"""
    ).fetchall()
    for row in rows:
        rule = first_match(rules, row)
        if rule is None:
            if row["source"] != "rule":
                continue
            # The rule that decided it is gone or no longer matches: the message waits again with no kind.
            connection.execute(
                "UPDATE mail_summary SET source = 'local', rule_id = NULL, kind = 'other', state = 'pending', confidentiality = ? WHERE message_id = ?",
                (row["account_level"], row["message_id"]),
            )
            continue
        kind = KIND_OF_ACTION.get(rule["action"], row["kind"])
        state = "quiet" if rule["action"] == "ignore" else "pending"
        level = stricter(row["account_level"], rule["confidentiality"])
        connection.execute(
            "UPDATE mail_summary SET kind = ?, source = 'rule', rule_id = ?, state = ?, confidentiality = ?, summary = CASE WHEN ? = 'normal' THEN summary ELSE NULL END WHERE message_id = ?",
            (kind, rule["id"], state, level, level, row["message_id"]),
        )
