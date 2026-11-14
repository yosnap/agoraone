"""Background classification and summaries of new mail, in small batches, one at a time.

Messages that may leave this Mac go to Claude Haiku through the user's Claude Code session or else the
Anthropic API (never the compatible provider), as data and without tools. The rest is settled here by the
user's rules and local keywords. A model failure pauses the worker and it tries again later, leaving those
messages for the next round; it never ends the thread."""

import asyncio
import sqlite3
import sys
import threading
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


def summarize_once(connection: sqlite3.Connection, engines: list[Engine], ask=_ask) -> int:
    """Classifies one batch; returns how many messages it handled (0 when nothing is waiting)."""
    messages = mail_inbox.unread(connection)
    if not messages:
        return 0
    remote, local = mail_inbox.plan(connection, messages)
    with transaction(connection):
        for entry in local:
            mail_inbox.store(connection, entry, None)
    if remote:
        candidates = [e for e in usable(engines) if e.name in ("claude-code", "anthropic-api")]
        if not candidates:
            raise EngineError("No hay sesión de Claude Code ni clave de API de Anthropic para resumir el correo.")
        reply = asyncio.run(ask(candidates[0], [entry["message"] for entry in remote]))
        found = mail_inbox.parse(reply, len(remote))
        with transaction(connection):
            for n, entry in enumerate(remote, 1):
                # A message the model left out is classified locally rather than asked about forever.
                mail_inbox.store(connection, entry, found.get(n))
    return len(messages)


def summary_worker(settings: Settings, make_engines: Callable[[], list[Engine]], stop: threading.Event, health: SummaryHealth) -> None:
    while not stop.is_set():
        wait = PAUSE_SECONDS
        try:
            connection = connect(settings.data_dir / DB_NAME)
            try:
                done = summarize_once(connection, make_engines())
            finally:
                connection.close()
            health.problem = None
            if not done:
                wait = IDLE_SECONDS
        except Exception as error:  # noqa: BLE001 - the worker must survive anything and say so
            if health.problem is None:
                print(f"AgoraOne núcleo: resúmenes de correo en pausa ({type(error).__name__})", file=sys.stderr)
            health.problem = str(error)[:200] if isinstance(error, EngineError) else "No se pudo resumir el correo; se reintentará."
            wait = FAILURE_SECONDS
        stop.wait(wait)
