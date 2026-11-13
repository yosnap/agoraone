"""HTTP routes of the index. `/internal/*` is for the backend only: the browser proxy does not forward it,
so the browser cannot write into the index."""

import re
import sqlite3
import sys
import threading
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from .db import DB_NAME, connect
from .embed import Embedder, VectorCache, embed_pending
from .graph import graph
from . import entities as entity_index
from .index import Note, RuleError, remove_notes, replace_folder_rules, state, status, upsert_notes
from .search import search
from .settings import Settings

SOURCE = r"^vault-[a-f0-9]{24}$"
REF = r"^note-[a-f0-9]{24}$"
IDLE_SECONDS = 30


class NoteIn(BaseModel):
    ref: str = Field(pattern=REF)
    title: str = Field(max_length=300)
    folder: str = Field(max_length=1000)
    revision: str = Field(max_length=100)
    modifiedAt: str = Field(max_length=40)
    text: str = Field(max_length=300_000)


class NotesIn(BaseModel):
    source: str = Field(pattern=SOURCE)
    sourceName: str = Field(max_length=100)
    notes: list[NoteIn] = Field(max_length=100)


class RemoveIn(BaseModel):
    source: str = Field(pattern=SOURCE)
    refs: list[str] = Field(max_length=5000)


class SourcesIn(BaseModel):
    keep: list[str] = Field(max_length=100)


class RuleIn(BaseModel):
    source: str = Field(pattern=r"^(\*|vault-[a-f0-9]{24})$")
    folder: str = Field(min_length=1, max_length=500)
    confidentiality: Literal["local_only", "private"]


class RulesIn(BaseModel):
    rules: list[RuleIn] = Field(max_length=200)


class EmbedHealth:
    """Whether the background embedding works right now, for /index/status."""

    def __init__(self):
        self.ok = True
        self.problem: str | None = None


def embed_worker(settings: Settings, embedder: Embedder, stop: threading.Event, health: EmbedHealth) -> None:
    """Embeds pending fragments in the background. Any failure (ollama away, a database error, an odd
    answer) pauses it and is retried later; it never ends the thread."""
    while not stop.is_set():
        try:
            with _open(settings) as connection:
                done = embed_pending(connection, embedder)
            health.ok, health.problem = True, None
        except Exception as error:  # noqa: BLE001 - the worker must survive anything and say so
            if health.ok:
                print(f"AgoraOne núcleo: búsqueda por significado en pausa: {error}", file=sys.stderr)
            health.ok, health.problem = False, str(error)[:200]
            done = 0
        if not done:
            stop.wait(IDLE_SECONDS)


@contextmanager
def _open(settings: Settings):
    connection = connect(settings.data_dir / DB_NAME)
    try:
        yield connection
    finally:
        connection.close()


def index_router(settings: Settings, embedder: Embedder | None, cache: VectorCache, health: EmbedHealth, extract_health=None) -> APIRouter:
    router = APIRouter()

    def run(work):
        def task():
            with _open(settings) as connection:
                return work(connection)
        return run_in_threadpool(task)

    @router.get("/internal/index/state")
    async def index_state(source: str = Query(pattern=SOURCE)):
        return {"refs": await run(lambda c: state(c, source))}

    @router.post("/internal/index/notes")
    async def index_notes(body: NotesIn):
        notes = [Note(n.ref, n.title, n.folder, n.revision, n.modifiedAt, n.text) for n in body.notes]
        return {"indexed": await run(lambda c: upsert_notes(c, body.source, body.sourceName, notes))}

    @router.post("/internal/index/remove")
    async def index_remove(body: RemoveIn):
        return {"removed": await run(lambda c: remove_notes(c, body.source, body.refs))}

    @router.post("/internal/index/sources")
    async def index_sources(body: SourcesIn):
        """Vaults no longer in Obsidian's registry leave the index (a disconnected one stays listed)."""
        keep = [source for source in body.keep if re.fullmatch(SOURCE.strip("^$"), source)]

        def prune(connection: sqlite3.Connection):
            placeholders = ",".join("?" * len(keep)) or "''"
            return connection.execute(
                f"DELETE FROM item WHERE class = 'note' AND source LIKE 'vault-%' AND source NOT IN ({placeholders})", keep
            ).rowcount
        return {"removed": await run(prune)}

    @router.get("/index/status")
    async def index_status():
        result = await run(status)
        extraction = await run(entity_index.status)
        return {**result, "semanticSearch": embedder is not None and health.ok, "semanticProblem": health.problem, "entities": {**extraction, "problem": getattr(extract_health, "problem", None)}}

    @router.get("/index/folder-rules")
    async def folder_rules():
        def read(connection: sqlite3.Connection):
            rows = connection.execute("SELECT source, folder, confidentiality FROM folder_rule ORDER BY source, folder")
            return [dict(row) for row in rows]
        return {"rules": await run(read)}

    @router.put("/index/folder-rules")
    async def put_folder_rules(body: RulesIn):
        rules = [(r.source, r.folder, r.confidentiality) for r in body.rules]
        try:
            return {"reclassified": await run(lambda c: replace_folder_rules(c, rules))}
        except RuleError as error:
            return JSONResponse({"error": str(error)}, status_code=422)

    @router.get("/search")
    async def find(
        q: str = Query(min_length=1, max_length=500),
        limit: int = Query(10, ge=1, le=50),
        audience: Literal["owner", "external"] = Query(),
    ):
        return await run(lambda c: search(c, q, embedder, cache, audience, limit))

    @router.get("/graph")
    async def brain_graph(discreet: bool = Query(False), near: bool = Query(True), entities: bool = Query(False),
                          tags: bool = Query(False), folders: bool = Query(False)):
        """For the owner's screen only: never sent to a model."""
        return await run(lambda c: graph(c, embedder, cache, discreet, near, entities, tags, folders))

    return router
