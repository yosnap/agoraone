"""Background reading of `normal` notes by Claude Haiku to find people, organisations and projects.

Batches of a few notes, one at a time, through the user's Claude Code session or else the Anthropic API
(never the compatible provider: the user chose Haiku). No tools, the note as data. Any failure pauses the
worker and it tries again later; it never ends the thread."""

import asyncio
import sqlite3
import sys
import threading
from collections.abc import Callable
from contextlib import aclosing

from . import entities
from .db import DB_NAME, connect
from .engines import EngineError, Engine, Turn, usable
from .settings import Settings

MODEL = "haiku"
IDLE_SECONDS = 60
PAUSE_SECONDS = 2
FAILURE_SECONDS = 300


class ExtractHealth:
    def __init__(self):
        self.problem: str | None = None


async def _ask(engine: Engine, notes: list[dict]) -> str:
    parts = []
    async with aclosing(engine.stream(Turn(entities.SYSTEM, [{"role": "user", "content": entities.prompt(notes)}], MODEL))) as stream:
        async for text in stream:
            if text:
                parts.append(text)
    return "".join(parts)


def extract_once(connection: sqlite3.Connection, engines: list[Engine]) -> int:
    """Reads one batch; returns how many notes it handled (0 when nothing is pending)."""
    notes = entities.pending(connection)
    if not notes:
        return 0
    candidates = [e for e in usable(engines) if e.name in ("claude-code", "anthropic-api")]
    if not candidates:
        raise EngineError("No hay sesión de Claude Code ni clave de API de Anthropic para leer las notas.")
    reply = asyncio.run(_ask(candidates[0], notes))
    entities.save_model(connection, notes, entities.parse(reply, {n["id"] for n in notes}))
    entities.prune(connection)
    return len(notes)


def entity_worker(settings: Settings, make_engines: Callable[[], list[Engine]], stop: threading.Event, health: ExtractHealth) -> None:
    while not stop.is_set():
        wait = PAUSE_SECONDS
        try:
            connection = connect(settings.data_dir / DB_NAME)
            try:
                done = extract_once(connection, make_engines())
            finally:
                connection.close()
            health.problem = None
            if not done:
                wait = IDLE_SECONDS
        except Exception as error:  # noqa: BLE001 - the worker must survive anything and say so
            if health.problem is None:
                print(f"AgoraOne núcleo: lectura de entidades en pausa: {error}", file=sys.stderr)
            health.problem = str(error)[:200]
            wait = FAILURE_SECONDS
        stop.wait(wait)
