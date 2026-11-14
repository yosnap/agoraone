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


async def _ask(engine: Engine, messages: list) -> str:
    parts = []
    turn = Turn(mail_inbox.SYSTEM, [{"role": "user", "content": mail_inbox.prompt(messages)}], MODEL)
    async with aclosing(engine.stream(turn)) as stream:
        async for text in stream:
            if text:
                parts.append(text)
    return "".join(parts)


class Budget:
    """At most MAX_CALLS model calls per hour, so a mailbox connected for the first time does not spend the
    user's Claude quota in one go; the rest waits for the next hour."""
    MAX_CALLS = 40

    def __init__(self, clock=time.monotonic):
        self.clock, self.calls = clock, []

    def take(self) -> bool:
        now = self.clock()
        self.calls = [t for t in self.calls if now - t < 3600]
        if len(self.calls) >= self.MAX_CALLS:
            return False
        self.calls.append(now)
        return True


MAX_ATTEMPTS = 3  # a batch the model keeps failing is classified locally, so it never blocks what comes after


def summarize_once(connection: sqlite3.Connection, engines: list[Engine], ask=_ask, budget: Budget | None = None,
                   attempts: dict[int, int] | None = None, health: SummaryHealth | None = None) -> int:
    """Classifies one round; returns how many messages it settled (0 when nothing can be done now).
    What may not leave this Mac is settled every round; one batch at most goes to the model."""
    attempts = attempts if attempts is not None else {}
    messages = mail_inbox.unread(connection)
    if not messages:
        return 0
    remote, local = mail_inbox.plan(connection, messages)
    batch = remote[:mail_inbox.BATCH]
    candidates = [e for e in usable(engines) if e.name in ("claude-code", "anthropic-api")]
    tired = [entry for entry in batch if attempts.get(entry["message"]["id"], 0) >= MAX_ATTEMPTS]
    if not candidates or tired:
        # Without Claude (or after repeated failures) these are classified locally, without a summary.
        if not candidates and health is not None:
            health.problem = "No hay sesión de Claude Code ni clave de API de Anthropic: el correo se clasifica sin resumen."
        local += batch if not candidates else tired
        batch = [] if not candidates else [e for e in batch if e not in tired]
    with transaction(connection):
        for entry in local:
            mail_inbox.store(connection, entry, None)
    if batch and (budget is None or budget.take()):
        reply, failure = None, None
        for engine in candidates:
            try:
                reply = asyncio.run(ask(engine, [entry["message"] for entry in batch]))
                break
            except Exception as error:  # noqa: BLE001 - try the next engine, then report
                failure = error
        if reply is None:
            for entry in batch:
                attempts[entry["message"]["id"]] = attempts.get(entry["message"]["id"], 0) + 1
            raise EngineError("Claude no pudo resumir el correo; se reintentará.") from failure
        found = mail_inbox.parse(reply, len(batch))
        with transaction(connection):
            for n, entry in enumerate(batch, 1):
                # A message the model left out is classified locally rather than asked about forever.
                mail_inbox.store(connection, entry, found.get(n))
                attempts.pop(entry["message"]["id"], None)
        return len(local) + len(batch)
    if batch and health is not None:
        health.problem = "Límite de resúmenes de esta hora alcanzado: el resto sigue en cuanto pase."
    return len(local)


def summary_worker(settings: Settings, make_engines: Callable[[], list[Engine]], stop: threading.Event, health: SummaryHealth) -> None:
    budget, attempts = Budget(), {}
    while not stop.is_set():
        wait = PAUSE_SECONDS
        try:
            connection = connect(settings.data_dir / DB_NAME)
            health.problem = None  # summarize_once says again what is still wrong
            try:
                done = summarize_once(connection, make_engines(), budget=budget, attempts=attempts, health=health)
            finally:
                connection.close()
            if not done:
                wait = IDLE_SECONDS
        except Exception as error:  # noqa: BLE001 - the worker must survive anything and say so
            if health.problem is None:
                print(f"AgoraOne núcleo: resúmenes de correo en pausa ({type(error).__name__})", file=sys.stderr)
            health.problem = str(error)[:200] if isinstance(error, EngineError) else "No se pudo resumir el correo; se reintentará."
            wait = FAILURE_SECONDS
        stop.wait(wait)
