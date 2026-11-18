"""Background classification and summaries of new mail, in small batches, one at a time.

Messages that may leave this Mac go to Claude Haiku through the user's Claude Code session or else the
Anthropic API (never the compatible provider), as data and without tools. The rest is settled here by the
user's rules and local keywords. A model failure pauses the worker and it tries again later, leaving those
messages for the next round; it never ends the thread."""

import asyncio
import sqlite3
import sys
import threading
import time
from collections.abc import Callable
from contextlib import aclosing
from dataclasses import dataclass

from . import mail_inbox
from .db import DB_NAME, connect, transaction
from .engines import Engine, EngineError, Turn, usable
from .settings import Settings

MODEL = "haiku"
IDLE_SECONDS = 60
PAUSE_SECONDS = 2
FAILURE_SECONDS = 300


class SummaryHealth:
    def __init__(self):
        self.problem: str | None = None


@dataclass(frozen=True)
class Reader:
    """What a summary round needs from one kind of message (mail, WhatsApp conversations): what waits, how it
    splits between the model and this Mac, how it is asked and how the answer is kept."""
    unread: Callable  # (connection) -> items waiting
    plan: Callable  # (connection, items) -> (remote entries, local entries)
    store: Callable  # (connection, entry, found or None)
    item: Callable  # entry -> what the model reads
    system: str
    prompt: Callable  # (items) -> text
    parse: Callable  # (reply, count) -> {n: found}
    batch: int
    what: str  # «el correo», for the user's messages
    name: str  # «correo», for the log


MAIL = Reader(mail_inbox.unread, mail_inbox.plan, mail_inbox.store, lambda entry: entry["message"], mail_inbox.SYSTEM,
              mail_inbox.prompt, mail_inbox.parse, mail_inbox.BATCH, "el correo", "correo")


async def _ask(engine: Engine, messages: list, reader: Reader = MAIL) -> str:
    parts = []
    turn = Turn(reader.system, [{"role": "user", "content": reader.prompt(messages)}], MODEL)
    async with aclosing(engine.stream(turn)) as stream:
        async for text in stream:
            if text:
                parts.append(text)
    return "".join(parts)


class Budget:
    """At most MAX_CALLS model calls per hour, so a mailbox connected for the first time does not spend the
    user's Claude quota in one go; the rest waits for the next hour. One budget is shared by the mail and WhatsApp
    workers, which run in different threads."""
    MAX_CALLS = 40

    def __init__(self, clock=time.monotonic):
        self.clock, self.calls, self.lock = clock, [], threading.Lock()

    def take(self) -> bool:
        with self.lock:
            now = self.clock()
            self.calls = [t for t in self.calls if now - t < 3600]
            if len(self.calls) >= self.MAX_CALLS:
                return False
            self.calls.append(now)
            return True


MAX_ATTEMPTS = 3  # a batch the model keeps failing is classified locally, so it never blocks what comes after


def summarize_once(connection: sqlite3.Connection, engines: list[Engine], ask=None, budget: Budget | None = None,
                   attempts: dict[int, int] | None = None, health: SummaryHealth | None = None, reader: Reader = MAIL) -> int:
    """Classifies one round; returns how many messages it settled (0 when nothing can be done now).
    What may not leave this Mac is settled every round; one batch at most goes to the model."""
    attempts = attempts if attempts is not None else {}
    ask = ask or (lambda engine, items: _ask(engine, items, reader))
    messages = reader.unread(connection)
    if not messages:
        return 0
    remote, local = reader.plan(connection, messages)
    batch = remote[:reader.batch]
    candidates = [e for e in usable(engines) if e.name in ("claude-code", "anthropic-api")]
    ident = lambda entry: reader.item(entry)["id"]  # noqa: E731
    tired = [entry for entry in batch if attempts.get(ident(entry), 0) >= MAX_ATTEMPTS]
    if not candidates or tired:
        # Without Claude (or after repeated failures) these are classified locally, without a summary.
        if not candidates and health is not None:
            health.problem = f"No hay sesión de Claude Code ni clave de API de Anthropic: {reader.what} se clasifica sin resumen."
        local += batch if not candidates else tired
        batch = [] if not candidates else [e for e in batch if e not in tired]
    with transaction(connection):
        for entry in local:
            reader.store(connection, entry, None)
    for entry in local:
        # Settled: if the same item waits again (a conversation with something new), it starts with a clean count.
        attempts.pop(ident(entry), None)
    if batch and (budget is None or budget.take()):
        reply, failure = None, None
        for engine in candidates:
            try:
                reply = asyncio.run(ask(engine, [reader.item(entry) for entry in batch]))
                break
            except Exception as error:  # noqa: BLE001 - try the next engine, then report
                failure = error
        if reply is None:
            for entry in batch:
                attempts[ident(entry)] = attempts.get(ident(entry), 0) + 1
            raise EngineError(f"Claude no pudo resumir {reader.what}; se reintentará.") from failure
        found = reader.parse(reply, len(batch))
        with transaction(connection):
            for n, entry in enumerate(batch, 1):
                # A message the model left out is classified locally rather than asked about forever.
                reader.store(connection, entry, found.get(n))
                attempts.pop(ident(entry), None)
        return len(local) + len(batch)
    if batch and health is not None:
        health.problem = "Límite de resúmenes de esta hora alcanzado: el resto sigue en cuanto pase."
    return len(local)


def summary_worker(settings: Settings, make_engines: Callable[[], list[Engine]], stop: threading.Event, health: SummaryHealth,
                   reader: Reader = MAIL, budget: Budget | None = None) -> None:
    """`budget` may be shared between workers, so they spend the user's Claude quota together."""
    budget, attempts = budget or Budget(), {}
    while not stop.is_set():
        wait = PAUSE_SECONDS
        try:
            connection = connect(settings.data_dir / DB_NAME)
            health.problem = None  # summarize_once says again what is still wrong
            try:
                done = summarize_once(connection, make_engines(), budget=budget, attempts=attempts, health=health, reader=reader)
            finally:
                connection.close()
            if not done:
                wait = IDLE_SECONDS
        except Exception as error:  # noqa: BLE001 - the worker must survive anything and say so
            if health.problem is None:
                print(f"AgoraOne núcleo: resúmenes de {reader.name} en pausa ({type(error).__name__})", file=sys.stderr)
            health.problem = str(error)[:200] if isinstance(error, EngineError) else f"No se pudo resumir {reader.what}; se reintentará."
            wait = FAILURE_SECONDS
        stop.wait(wait)
