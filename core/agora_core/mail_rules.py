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
# The same limits as Settings (RuleIn) and the table, for every way a rule arrives (Watson's proposals too).
_LIMITS = {"name": 80, "sender": 254, "subject": 200, "words": 200}
_FIELD_NAMES = {"name": "nombre", "sender": "remitente", "subject": "asunto", "words": "palabras"}
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
        if isinstance(value, str) and len(value) > _LIMITS.get(key, 10_000):
            raise RuleError(f"Texto demasiado largo ({_FIELD_NAMES.get(key, key)}): {_LIMITS[key]} caracteres como máximo.")
        if key == "sender" and value is not None:
            value = value.lower().lstrip("@")
            if not _SENDER.fullmatch(value):
                raise RuleError("El remitente debe ser una dirección (ana@cliente.com) o un dominio (cliente.com).")
        if key == "words" and value is not None and not word_list(value):
            raise RuleError("Escribe al menos una palabra (separadas por comas).")
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


def check_rule(data: dict) -> dict:
    """The rule as it would be created (same checks as `create_rule`), in the request's own field names;
    nothing is written. A proposal from Watson goes through this before the user sees it."""
    values = _clean(data)
    if not values.get("name") or not values.get("action"):
        raise RuleError("La regla necesita un nombre y una acción.")
    if not any(values.get(c) is not None for c in ("sender", "account_id", "subject", "words")):
        raise RuleError("La regla necesita al menos una condición: remitente, cuenta, asunto o palabras.")
    back = {column: key for key, column in _FIELDS.items()}
    return {back[column]: value for column, value in values.items() if value is not None}


def create_rule(connection: sqlite3.Connection, data: dict) -> int:
    check_rule(data)
    values = _clean(data)
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


def word_list(words: str) -> list[str]:
    return [w.strip().casefold() for w in words.split(",") if w.strip()]


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
    if rule["words"] and not any_word(rule["words"], subject + "\n" + (message["body"] or "")):
        return False
    return True


def any_word(words: str, text: str) -> bool:
    """Whether any of the comma-separated words is in the text as a whole word, ignoring case."""
    text = text.casefold()
    return any(re.search(rf"(?<!\w){re.escape(w)}(?!\w)", text) for w in word_list(words))


def enabled_rules(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute("SELECT * FROM mail_rule WHERE enabled = 1 ORDER BY id").fetchall()


def first_match(rules: list, message) -> sqlite3.Row | None:
    return next((rule for rule in rules if matches(rule, message)), None)


def reapply(connection: sqlite3.Connection) -> None:
    """Applies the current rules and account levels again, without calling any model. Every message gets its
    effective confidentiality now, and loses its summary and details as soon as it is no longer `normal`.
    Undecided messages (pending or quiet) also get the kind and state of the rule that matches now; decided
    ones keep the user's decision. Runs after any change of rules or accounts."""
    from .mail_inbox import local_kind

    rules = enabled_rules(connection)
    rows = connection.execute(
        """SELECT s.message_id, s.kind, s.source, s.rule_id, s.state, m.account_id, m.from_address, m.subject,
                  m.body, a.confidentiality AS account_level
           FROM mail_summary s JOIN mail_message m ON m.id = s.message_id JOIN mail_account a ON a.id = m.account_id"""
    ).fetchall()
    for row in rows:
        rule = first_match(rules, row)
        level = stricter(row["account_level"], rule["confidentiality"] if rule else None)
        kind, source, rule_id, state = row["kind"], row["source"], row["rule_id"], row["state"]
        if state in ("pending", "quiet"):
            if rule is not None:
                kind, source, rule_id = KIND_OF_ACTION.get(rule["action"], kind), "rule", rule["id"]
                state = "quiet" if rule["action"] == "ignore" else "pending"
            elif source == "rule":
                # The rule that decided it is gone or no longer matches: local keywords decide again.
                kind, source, rule_id = local_kind(row["subject"], row["body"]), "local", None
                state = "quiet" if kind == "advertising" else "pending"
        connection.execute(
            """UPDATE mail_summary SET kind = ?, source = ?, rule_id = ?, state = ?, confidentiality = ?,
                      summary = CASE WHEN ? = 'normal' THEN summary END,
                      details = CASE WHEN ? = 'normal' THEN details ELSE '{}' END
               WHERE message_id = ?""",
            (kind, source, rule_id, state, level, level, level, row["message_id"]),
        )
