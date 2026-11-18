"""Jev in shadow for mail and WhatsApp: after each summary round, the messages and conversations kept as normal
(whoever decided them: a rule, Claude Haiku or local keywords) are asked about to Jev in a thread of their own, and
its answers are kept in `jev_decision` with `applied = 0`. Nothing of what is stored or shown changes: not the kind,
not the summary, not the state in the Bandeja.

The round never waits for Jev and never fails because of it: a pass runs in its own thread with its own connection,
at most one at a time per kind, and any failure of Jev (off, no key, cap reached, unreachable) only pauses the next
passes. What did not get an answer is asked again in a later pass for SHADOW_DAYS days. The level is checked again
right before asking (stored level, account and rules as they are now) and `jev.ask` checks it once more."""

import json
import sqlite3
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx

from . import chat_inbox, jev, mail_inbox, modules

PURPOSE = "class"
SHADOW_DAYS = 3  # items classified this long ago or less are still asked about
PER_PASS = 20
PAUSE_SECONDS = 300  # after Jev is off, has no key, is over its cap or does not answer
MAX_FAILURES = 3  # an item Jev keeps refusing is left alone (until AgoraOne restarts)
STATE_CHARS = 12_000


@dataclass(frozen=True)
class Subject:
    """One kind of thing Jev shadows: the subject and decision point in Jev (`mail`, `chat`), what waits for an answer,
    its level now and state, and the questions."""
    name: str
    waiting: Callable  # (connection, since, purpose, limit) -> [subject ids]
    entry: Callable  # (connection, subject id) -> (level now, state) or None
    questions: dict


MAIL = Subject("mail", mail_inbox.jev_waiting, mail_inbox.jev_entry, mail_inbox.JEV_QUESTIONS)
CHAT = Subject("chat", chat_inbox.jev_waiting, chat_inbox.jev_entry, chat_inbox.JEV_QUESTIONS)


def _since(days: int = SHADOW_DAYS) -> str:
    return (datetime.now(UTC) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


class Shadow:
    """Shadow passes of one subject. `open_db` opens a new connection (each thread its own); `secrets` gives the key
    from the Keychain; `client` an httpx client for tests (None: one of its own per request)."""

    def __init__(self, subject: Subject, open_db: Callable[[], sqlite3.Connection], secrets,
                 client: Callable[[], httpx.Client | None] = lambda: None, clock: Callable[[], float] = time.monotonic):
        self.subject, self.open_db, self.secrets, self.client, self.clock = subject, open_db, secrets, client, clock
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.paused_until = 0.0
        self.failures: dict[str, int] = {}

    def kick(self) -> None:
        """Starts a pass in its own thread unless one is running or Jev asked for a pause. Never waits, never raises."""
        try:
            with self.lock:
                if (self.thread is not None and self.thread.is_alive()) or self.clock() < self.paused_until:
                    return
                self.thread = threading.Thread(target=self._pass, name=f"jev-sombra-{self.subject.name}", daemon=True)
                self.thread.start()
        except Exception as error:  # noqa: BLE001 - the summary round must never notice Jev
            print(f"AgoraOne núcleo: Jev en sombra no arrancó ({type(error).__name__}).", file=sys.stderr)

    def _pause(self) -> None:
        self.paused_until = self.clock() + PAUSE_SECONDS

    def _pass(self) -> None:
        try:
            connection = self.open_db()
            try:
                self.run_once(connection)
            finally:
                connection.close()
        except Exception as error:  # noqa: BLE001 - a broken pass only pauses the next ones
            print(f"AgoraOne núcleo: Jev en sombra en pausa ({type(error).__name__}).", file=sys.stderr)
            self._pause()

    def _failed(self, ident: str, final: bool = False) -> None:
        if len(self.failures) > 5000:
            self.failures.clear()
        self.failures[ident] = MAX_FAILURES if final else self.failures.get(ident, 0) + 1

    def run_once(self, connection: sqlite3.Connection) -> int:
        """Asks Jev about up to PER_PASS waiting items with `connection` (this thread's own); returns how many answers
        it kept. Reads the key only when there is something to ask and Jev is on."""
        name = self.subject.name
        if not modules.state(connection).get("jev", True) or not jev.settings(connection)["points"].get(name, False):
            return 0
        left_alone = sum(1 for count in self.failures.values() if count >= MAX_FAILURES)
        waiting = [ident for ident in self.subject.waiting(connection, _since(), PURPOSE, PER_PASS + left_alone)
                   if self.failures.get(ident, 0) < MAX_FAILURES][:PER_PASS]
        if not waiting:
            return 0
        key = self.secrets.get(jev.SECRET)
        if not key:
            self._pause()
            return 0
        kept = 0
        for ident in waiting:
            found = self.subject.entry(connection, ident)
            if found is None or found[0] != "normal":
                self._failed(ident, final=True)  # gone, classified again, or no longer normal: it never goes out
                continue
            level, state = found
            try:
                answer = jev.ask(connection, key, state, self.subject.questions, level=level, point=name,
                                 max_chars=STATE_CHARS, client=self.client())
                jev.record(connection, name, ident, PURPOSE, answer, applied=False)
            except jev.JevError as error:
                if error.status in ("invalid", "private", "storage"):
                    self._failed(ident)
                    continue
                self._pause()  # off, no key, cap, limit, overloaded or unreachable: the next passes wait
                break
            kept += 1
        return kept


# ---- what Jev said next to what is shown, for the private evaluation and Settings › Jev ------------------------

_LEVEL_MAIL = """CASE WHEN 'private' IN (s.confidentiality, a.confidentiality, COALESCE(r.confidentiality, '')) THEN 'private'
                 WHEN 'local_only' IN (s.confidentiality, a.confidentiality, COALESCE(r.confidentiality, '')) THEN 'local_only'
                 ELSE 'normal' END"""
_QUERIES = {
    "mail": f"""SELECT j.subject_id, j.answers, j.model, j.created_at, s.kind, s.source, s.state, m.moved, 1 AS same_window,
                       CASE WHEN s.message_id IS NULL THEN NULL ELSE {_LEVEL_MAIL} END AS level
                FROM jev_decision j
                LEFT JOIN mail_summary s ON s.message_id = CAST(j.subject_id AS INTEGER)
                LEFT JOIN mail_message m ON m.id = s.message_id LEFT JOIN mail_account a ON a.id = m.account_id
                LEFT JOIN mail_rule r ON r.id = s.rule_id
                WHERE j.subject = 'mail' AND j.purpose = ?""",
    "chat": f"""SELECT j.subject_id, j.answers, j.model, j.created_at, s.kind, s.source, s.state, NULL AS moved,
                       s.until_message_id = CAST(substr(j.subject_id, instr(j.subject_id, ':') + 1) AS INTEGER) AS same_window,
                       CASE WHEN s.conversation_id IS NULL THEN NULL ELSE {_LEVEL_MAIL} END AS level
                FROM jev_decision j
                LEFT JOIN chat_summary s ON s.conversation_id = CAST(substr(j.subject_id, 1, instr(j.subject_id, ':') - 1) AS INTEGER)
                LEFT JOIN chat_conversation c ON c.id = s.conversation_id LEFT JOIN chat_account a ON a.id = c.account_id
                LEFT JOIN chat_rule r ON r.id = s.rule_id
                WHERE j.subject = 'chat' AND j.purpose = ?""",
}
_NOULS = {"asks_user": "asksUser", "deadline": "deadline", "from_client": "fromClient", "awaits_reply": "awaitsReply", "injection": "injection"}


def _graded(answer: dict | None) -> dict | None:
    return {"value": answer["value"], "confidence": answer["confidence"]} if isinstance(answer, dict) and "value" in answer else None


def _jev(answers: str) -> dict:
    try:
        found = json.loads(answers)
    except ValueError:
        found = {}
    found = found if isinstance(found, dict) else {}
    said = {"kind": _graded(found.get("kind")), "urgency": _graded(found.get("urgency"))}
    for ident, name in _NOULS.items():
        if isinstance(found.get(ident), dict):
            said[name] = found[ident].get("value")
    return said


def shadow_items(connection: sqlite3.Connection, subject: str, limit: int = 500) -> list[dict]:
    """Per decision, newest first: Jev's kind with its confidence and its other answers, the kind shown today with who
    decided it (rule, model or local) and what the user did (the card's state; for mail, whether it was moved). Never
    the text of a message nor a name: only identifiers, kinds and numbers."""
    rows = connection.execute(f"{_QUERIES[subject]} ORDER BY j.id DESC LIMIT ?", (PURPOSE, limit)).fetchall()
    items = []
    for row in rows:
        jev_said = _jev(row["answers"])
        current = {"kind": row["kind"], "source": row["source"]} if row["kind"] is not None else None
        same = bool(row["same_window"]) if current else False
        kind = (jev_said.get("kind") or {}).get("value")
        items.append({"id": row["subject_id"], "decidedAt": row["created_at"], "model": row["model"], "jev": jev_said,
                      "current": current, "level": row["level"], "sameWindow": same,
                      "user": {"state": row["state"], "moved": row["moved"]} if current else None,
                      "agrees": (kind == row["kind"]) if current and same and kind else None})
    return items


def shadow_counts(connection: sqlite3.Connection, subject: str) -> dict:
    """How many decisions Jev took in shadow, how many can be compared with what is shown now and in how many it agrees."""
    found = connection.execute(
        f"""SELECT count(*) AS decisions,
                   coalesce(sum(CASE WHEN q.kind IS NOT NULL AND q.same_window AND json_extract(q.answers, '$.kind.value') IS NOT NULL THEN 1 ELSE 0 END), 0) AS compared,
                   coalesce(sum(CASE WHEN q.kind IS NOT NULL AND q.same_window AND json_extract(q.answers, '$.kind.value') = q.kind THEN 1 ELSE 0 END), 0) AS agree
            FROM ({_QUERIES[subject]}) q""", (PURPOSE,)).fetchone()
    return {"decisions": found["decisions"], "compared": found["compared"], "agree": found["agree"]}
