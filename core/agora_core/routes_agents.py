"""The «Agentes» section (1.7): what Watson is doing now and what it did in the last 24 h, from the action log.
Only who, which action, how it ended and when: never the details (searched words, recipients, notes), which stay in
the log for the summary and the checks that need them."""

import re
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

from .db import DB_NAME, connect
from .routes_assistant import ANSWERING
from .settings import Settings

WINDOW = timedelta(hours=24)
MAX_EVENTS = 80
_ACTION = re.compile(r"^[a-z_.]{1,40}$")  # the log's own action names; anything else is not shown


def watson_activity(connection, now: datetime | None = None) -> dict:
    since = ((now or datetime.now(UTC)) - WINDOW).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = connection.execute("SELECT occurred_at, actor, action, outcome FROM action_log WHERE occurred_at >= ? ORDER BY occurred_at DESC, id DESC LIMIT ?",
                              (since, MAX_EVENTS)).fetchall()
    events = [{"at": r["occurred_at"], "actor": "watson" if r["actor"] == "watson" else "user", "action": r["action"], "outcome": r["outcome"]}
              for r in rows if _ACTION.match(r["action"] or "")]
    return {"answering": ANSWERING["now"], "since": ANSWERING["since"], "lastAt": events[0]["at"] if events else None, "events": events}


def agents_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.get("/agents/watson")
    async def watson():
        def job():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                return watson_activity(connection)
            finally:
                connection.close()
        return await run_in_threadpool(job)

    return router
