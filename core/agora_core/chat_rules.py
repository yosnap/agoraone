"""The user's rules for WhatsApp conversations: a condition (contact, account, words in what was received) and what
it means (invoice, client, personal, important or ignore), with an optional label shown as the conversation's
source (for example the name of a service that writes from a known number). As with mail, the first enabled rule
that matches, oldest first, decides, and a rule can only make a conversation's confidentiality stricter than its
account's, never looser. Applying the rules again never calls a model."""

import re
import sqlite3

from .db import now, transaction
from .mail_rules import ACTIONS, KIND_OF_ACTION, LEVELS, RuleError, any_word, stricter, word_list

_FIELDS = {"name": "name", "contact": "contact", "accountId": "account_id", "words": "words", "action": "action",
           "label": "label", "scopeId": "scope_id", "confidentiality": "confidentiality", "enabled": "enabled"}
_LIMITS = {"name": 80, "contact": 100, "words": 200, "label": 40}
_FIELD_NAMES = {"name": "nombre", "contact": "contacto", "words": "palabras", "label": "etiqueta"}
_PHONE = re.compile(r"\+?[\d\s().-]{6,40}")
_PARTICIPANT = re.compile(r"[\w.:@-]{1,100}")
MIN_DIGITS = 9  # a number written without its country code still matches, but never a short fragment
NEED_CONDITION = "La regla necesita al menos una condición: contacto, cuenta o palabras."

def digits(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def _contact(value: str) -> str:
    """A phone number kept as «+» and its digits (or only the digits), or a participant id as given."""
    if _PHONE.fullmatch(value) and len(digits(value)) >= 6:
        return ("+" if value.startswith("+") else "") + digits(value)
    if not _PARTICIPANT.fullmatch(value):
        raise RuleError("El contacto debe ser un número de teléfono (+34 600 000 000) o el identificador del participante.")
    return value


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
        if key == "contact" and value is not None:
            value = _contact(value)
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
    if values.get("account_id") is not None and not connection.execute("SELECT 1 FROM chat_account WHERE id = ?", (values["account_id"],)).fetchone():
        raise RuleError("Esa cuenta de WhatsApp no existe.")
    if values.get("scope_id") is not None and not connection.execute("SELECT 1 FROM scope WHERE id = ?", (values["scope_id"],)).fetchone():
        raise RuleError("Ese ámbito no existe.")


def create_rule(connection: sqlite3.Connection, data: dict) -> int:
    values = _clean(data)
    if not values.get("name") or not values.get("action"):
        raise RuleError("La regla necesita un nombre y una acción.")
    if not any(values.get(c) is not None for c in ("contact", "account_id", "words")):
        raise RuleError(NEED_CONDITION)
    _check_refs(connection, values)
    columns = [*values, "created_at"]
    with transaction(connection):
        cursor = connection.execute(
            f"INSERT INTO chat_rule ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", [*values.values(), now()])
        reapply(connection)
    return cursor.lastrowid


def update_rule(connection: sqlite3.Connection, rule_id: int, changes: dict) -> bool:
    values = _clean(changes)
    if "name" in values and not values["name"] or "action" in values and not values["action"] or "enabled" in changes and changes["enabled"] is None:
        raise RuleError("La regla necesita un nombre y una acción.")
    _check_refs(connection, values)
    with transaction(connection):
        if not connection.execute("SELECT 1 FROM chat_rule WHERE id = ?", (rule_id,)).fetchone():
            return False
        if values:
            try:
                connection.execute(f"UPDATE chat_rule SET {', '.join(f'{c} = ?' for c in values)} WHERE id = ?", [*values.values(), rule_id])
            except sqlite3.IntegrityError as error:
                raise RuleError(NEED_CONDITION) from error
        reapply(connection)
    return True


def delete_rule(connection: sqlite3.Connection, rule_id: int) -> bool:
    with transaction(connection):
        deleted = connection.execute("DELETE FROM chat_rule WHERE id = ?", (rule_id,)).rowcount > 0
        reapply(connection)
    return deleted


def list_rules(connection: sqlite3.Connection) -> list[dict]:
    return [{"id": r["id"], "name": r["name"], "contact": r["contact"], "accountId": r["account_id"], "words": r["words"],
             "action": r["action"], "label": r["label"], "scopeId": r["scope_id"], "confidentiality": r["confidentiality"],
             "enabled": bool(r["enabled"])} for r in connection.execute("SELECT * FROM chat_rule ORDER BY id")]


def _contact_matches(rule_contact: str, conversation) -> bool:
    wanted = digits(rule_contact)
    if not rule_contact.lstrip("+").isdigit():
        return rule_contact == (conversation["participant_id"] or "")
    for candidate in (digits(conversation["participant_phone"]), digits(conversation["participant_id"])):
        if candidate and (candidate == wanted or len(min(candidate, wanted, key=len)) >= MIN_DIGITS
                          and (candidate.endswith(wanted) or wanted.endswith(candidate))):
            return True
    return False


def matches(rule, conversation, text: str) -> bool:
    """`conversation` carries account_id, participant_id and participant_phone; `text` is what was received."""
    if rule["contact"] and not _contact_matches(rule["contact"], conversation):
        return False
    if rule["account_id"] is not None and rule["account_id"] != conversation["account_id"]:
        return False
    return not rule["words"] or any_word(rule["words"], text)


def enabled_rules(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute("SELECT * FROM chat_rule WHERE enabled = 1 ORDER BY id").fetchall()


def first_match(rules: list, conversation, text: str):
    return next((rule for rule in rules if matches(rule, conversation, text)), None)


def reapply(connection: sqlite3.Connection) -> None:
    """Applies the current rules and account levels again, without calling any model. Every conversation gets its
    effective confidentiality now and loses its summary and details as soon as it is no longer `normal`.
    Undecided ones (pending or quiet) also get the kind, label and state of the rule that matches now; a
    conversation kept quiet because nothing recent had arrived stays quiet. Decided ones keep the user's decision.
    Runs after any change of rules or accounts, inside the caller's transaction."""
    from . import chat_inbox

    rules = enabled_rules(connection)
    rows = connection.execute(
        """SELECT s.conversation_id, s.kind, s.source, s.rule_id, s.label, s.state, c.account_id, c.participant_id,
                  c.participant_phone, a.confidentiality AS account_level,
                  (SELECT max(COALESCE(m.sent_at, m.created_at)) FROM chat_message m
                   WHERE m.conversation_id = c.id AND m.direction = 'incoming') AS last_incoming_at
           FROM chat_summary s JOIN chat_conversation c ON c.id = s.conversation_id JOIN chat_account a ON a.id = c.account_id"""
    ).fetchall()
    for row in rows:
        text = chat_inbox.received_text(connection, row["conversation_id"])
        rule = first_match(rules, row, text)
        level = stricter(row["account_level"], rule["confidentiality"] if rule else None)
        kind, source, rule_id, label, state = row["kind"], row["source"], row["rule_id"], row["label"], row["state"]
        if state in ("pending", "quiet"):
            stale = state == "quiet" and chat_inbox.is_old(row["last_incoming_at"])
            if rule is not None:
                kind, source, rule_id, label = KIND_OF_ACTION.get(rule["action"], kind), "rule", rule["id"], rule["label"]
                state = "quiet" if rule["action"] == "ignore" or stale else "pending"
            elif source == "rule":
                # The rule that decided it is gone or no longer matches: local keywords decide again.
                kind, source, rule_id, label = chat_inbox.local_kind(text), "local", None, None
                state = "quiet" if kind == "advertising" or stale else "pending"
        connection.execute(
            """UPDATE chat_summary SET kind = ?, source = ?, rule_id = ?, label = ?, state = ?, confidentiality = ?,
                      summary = CASE WHEN ? = 'normal' THEN summary END,
                      details = CASE WHEN ? = 'normal' THEN details ELSE '{}' END
               WHERE conversation_id = ?""",
            (kind, source, rule_id, label, state, level, level, level, row["conversation_id"]),
        )
