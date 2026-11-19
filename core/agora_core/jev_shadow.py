"""Jev in shadow for mail and WhatsApp: after each summary round, the messages and conversations kept as normal
(whoever decided them: a rule, Claude Haiku or local keywords; never what a rule «ignore» silenced, which the user
wants left alone) are asked about to Jev in a thread of their own, and
its answers are kept in `jev_decision` with `applied = 0`. Nothing of what is stored or shown changes: not the kind,
not the summary, not the state in the Bandeja.

The round never waits for Jev and never fails because of it: a pass runs in its own thread with its own connection,
at most one at a time per kind, and any failure of Jev (off, no key, cap reached, unreachable) only pauses the next
passes; an item that breaks is only left aside. Only items received in the last SHADOW_DAYS days are asked about, and
what did not get an answer is asked again in a later pass. The level is checked again right before asking (stored
level, account and rules as they are now) and `jev.ask` checks it once more. Turning off «Correo» or «WhatsApp» stops
the pass in course before its next item.

The comparison (`GET /jev/shadow`, Settings › Jev) only shows what is still normal now: what became local_only or
private later, or whose summary is gone, is only counted as withdrawn."""

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
SHADOW_DAYS = 3  # items received (and classified) this long ago or less are asked about
PER_PASS = 20
PAUSE_SECONDS = 300  # after Jev is off, has no key, is over its cap or does not answer
AUTH_PAUSE_SECONDS = 3600  # after TypeSafe refused the key: no point in trying every few minutes
MAX_FAILURES = 3  # an item Jev keeps refusing is left alone (until AgoraOne restarts)
STATE_CHARS = 12_000


@dataclass(frozen=True)
class Subject:
    """One kind of thing Jev shadows: the subject and decision point in Jev (`mail`, `chat`), the module it belongs to,
    what waits for an answer, its level now and state, and the questions."""
    name: str
    module: str
    waiting: Callable  # (connection, since, purpose, limit) -> [subject ids]
    entry: Callable  # (connection, subject id) -> (level now, state) or None
    rules: Callable  # (connection) -> the enabled rules
    level: Callable  # (connection, subject id, rules) -> level now, or None when gone
    questions: dict


MAIL = Subject("mail", "correo", mail_inbox.jev_waiting, mail_inbox.jev_entry, mail_inbox.jev_rules, mail_inbox.jev_level, mail_inbox.JEV_QUESTIONS)
CHAT = Subject("chat", "whatsapp", chat_inbox.jev_waiting, chat_inbox.jev_entry, chat_inbox.jev_rules, chat_inbox.jev_level, chat_inbox.JEV_QUESTIONS)


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

    def _pause(self, seconds: float = PAUSE_SECONDS) -> None:
        self.paused_until = self.clock() + seconds

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
        if not self._on(connection):
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
            if not self._on(connection):
                break  # the module or Jev was turned off meanwhile
            try:
                found = self.subject.entry(connection, ident)
                if found is None or found[0] != "normal":
                    self._failed(ident, final=True)  # gone, classified again, ignored or no longer normal: it never goes out
                    continue
                level, state = found
                answer = jev.ask(connection, key, state, self.subject.questions, level=level, point=name,
                                 max_chars=STATE_CHARS, client=self.client())
                jev.record(connection, name, ident, PURPOSE, answer, applied=False)
            except jev.JevError as error:
                if error.status in ("invalid", "private", "storage"):
                    self._failed(ident)
                    continue
                # Off, no key, cap, limit, overloaded or unreachable: the next passes wait (long after a refused key).
                self._pause(AUTH_PAUSE_SECONDS if error.status == "auth" else PAUSE_SECONDS)
                break
            except Exception as error:  # noqa: BLE001 - one broken item (odd data, a busy database) never blocks the rest
                print(f"AgoraOne núcleo: Jev en sombra dejó un elemento ({type(error).__name__}).", file=sys.stderr)
                self._failed(ident)
                continue
            kept += 1
        return kept

    def _on(self, connection: sqlite3.Connection) -> bool:
        on = modules.state(connection)
        return on.get(self.subject.module, False) and on.get("jev", False) and jev.settings(connection)["points"].get(self.subject.name, False)


# ---- what Jev said next to what is shown, for the private evaluation and Settings › Jev ------------------------

_QUERIES = {
    "mail": """SELECT j.subject_id, j.answers, j.model, j.created_at, s.kind, s.source, s.state, m.moved, 1 AS same_window
               FROM jev_decision j
               LEFT JOIN mail_summary s ON s.message_id = CAST(j.subject_id AS INTEGER)
               LEFT JOIN mail_message m ON m.id = s.message_id
               WHERE j.subject = 'mail' AND j.purpose = ? ORDER BY j.id DESC""",
    "chat": """SELECT j.subject_id, j.answers, j.model, j.created_at, s.kind, s.source, s.state, NULL AS moved,
                      s.until_message_id = CAST(substr(j.subject_id, instr(j.subject_id, ':') + 1) AS INTEGER) AS same_window
               FROM jev_decision j
               LEFT JOIN chat_summary s ON s.conversation_id = CAST(substr(j.subject_id, 1, instr(j.subject_id, ':') - 1) AS INTEGER)
               WHERE j.subject = 'chat' AND j.purpose = ? ORDER BY j.id DESC""",
}
_SUBJECTS = {"mail": MAIL, "chat": CHAT}
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


def _compared(connection: sqlite3.Connection, subject: str) -> tuple[list[dict], int]:
    """Every decision still about something normal now, newest first, and how many were withdrawn (the item became
    local_only or private, or its summary is gone). The level is worked out as for asking: stored, account and the
    rules as they are now."""
    kind_of = _SUBJECTS[subject]
    rules, levels = kind_of.rules(connection), {}
    items, withdrawn = [], 0
    for row in connection.execute(_QUERIES[subject], (PURPOSE,)).fetchall():
        owner = row["subject_id"].partition(":")[0]
        if owner not in levels:
            levels[owner] = kind_of.level(connection, row["subject_id"], rules) if row["kind"] is not None else None
        if levels[owner] != "normal":
            withdrawn += 1
            continue
        said = _jev(row["answers"])
        kind = (said.get("kind") or {}).get("value")
        same = bool(row["same_window"])
        # Mail and WhatsApp keep as «other» the advertising no rule nor unsubscribe words confirm, whatever the model
        # said: Jev's «advertising» there says nothing about agreeing, so it is left out of the comparison.
        hidden_ad = kind == "advertising" and row["kind"] == "other" and row["source"] != "rule"
        items.append({"id": row["subject_id"], "decidedAt": row["created_at"], "model": row["model"], "jev": said,
                      "current": {"kind": row["kind"], "source": row["source"]}, "sameWindow": same,
                      "user": {"state": row["state"], "moved": row["moved"]},
                      "agrees": (kind == row["kind"]) if same and kind and not hidden_ad else None, "advertisingAsOther": hidden_ad})
    return items, withdrawn


def shadow_items(connection: sqlite3.Connection, subject: str, limit: int = 500) -> list[dict]:
    """Per decision still about something normal, newest first: Jev's kind with its confidence and its other answers,
    the kind shown today with who decided it (rule, model or local) and what the user did (the card's state; for mail,
    whether it was moved). Never the text of a message nor a name: only identifiers, kinds and numbers."""
    return _compared(connection, subject)[0][:limit]


def _counts(items: list[dict], withdrawn: int) -> dict:
    return {"decisions": len(items), "compared": sum(1 for i in items if i["agrees"] is not None),
            "agree": sum(1 for i in items if i["agrees"]), "advertisingAsOther": sum(1 for i in items if i["advertisingAsOther"]),
            "withdrawn": withdrawn}


def shadow_counts(connection: sqlite3.Connection, subject: str) -> dict:
    """How many decisions about something still normal Jev took in shadow, how many compare with what is shown now,
    in how many it agrees, how many are advertising kept as «other» (left out) and how many were withdrawn."""
    return _counts(*_compared(connection, subject))


def shadow_report(connection: sqlite3.Connection, subject: str, limit: int = 500) -> dict:
    """The items (as `shadow_items`) and the counts (as `shadow_counts`) in one reading."""
    items, withdrawn = _compared(connection, subject)
    return {"subject": subject, "counts": _counts(items, withdrawn), "items": items[:limit]}
