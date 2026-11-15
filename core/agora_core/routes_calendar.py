"""HTTP routes of the calendar: permission, calendars and their scope and confidentiality, the agenda with
overlaps, and creating an event or a reminder, only after the user confirms it in the app (never deleting)."""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool, StrictInt

from . import calendar_store, mail_inbox
from .db import DB_NAME, connect
from .settings import Settings

Level = Literal["normal", "local_only", "private"]


class CalendarChange(BaseModel):
    scopeId: StrictInt | None = None
    confidentiality: Level = "normal"
    hidden: StrictBool = False


class EventIn(BaseModel):
    calendarId: Annotated[str, Field(max_length=200)] | None = None
    title: Annotated[str, Field(min_length=1, max_length=200)]
    start: datetime
    end: datetime
    allDay: StrictBool = False
    location: Annotated[str, Field(max_length=300)] | None = None
    notes: Annotated[str, Field(max_length=4000)] | None = None
    overlapOk: StrictBool = False  # the user saw the clashes and still wants it
    inboxId: StrictInt | None = None  # the Bandeja card it comes from, marked done once created


class ReminderIn(BaseModel):
    calendarId: Annotated[str, Field(max_length=200)] | None = None
    title: Annotated[str, Field(min_length=1, max_length=200)]
    due: datetime | None = None
    notes: Annotated[str, Field(max_length=4000)] | None = None
    inboxId: StrictInt | None = None


def calendar_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    async def db(work):
        def run():
            with database() as connection:
                return work(connection)
        return await run_in_threadpool(run)

    def refuse(message: str, status: int = 422, **extra):
        return JSONResponse({"error": message, **extra}, status_code=status)

    def ready(store) -> str | None:
        status = store.status()
        if status["events"] == "unavailable":
            return "El calendario de macOS no está disponible aquí."
        if status["events"] != "granted":
            return "AgoraOne aún no tiene permiso para leer tus calendarios: dáselo en Ajustes › Calendarios."
        return None

    @router.get("/calendar/status")
    async def status():
        return await run_in_threadpool(calendar_store.shared().status)

    @router.post("/calendar/access")
    async def access():
        return await run_in_threadpool(calendar_store.shared().request)

    @router.get("/calendar/calendars")
    async def calendars():
        store = calendar_store.shared()
        if problem := ready(store):
            return {"calendars": [], "problem": problem}
        found = await run_in_threadpool(store.calendars)
        chosen = await db(calendar_store.settings)
        return {"calendars": [{**c, "scopeId": None, "confidentiality": "normal", "hidden": False, **chosen.get(c["id"], {})} for c in found],
                "problem": None}

    @router.put("/calendar/calendars/{calendar_id}")
    async def change(calendar_id: str, body: CalendarChange):
        if not 1 <= len(calendar_id) <= 200:
            return refuse("Calendario no válido.")

        def work(connection: sqlite3.Connection):
            if body.scopeId is not None and not connection.execute("SELECT 1 FROM scope WHERE id = ?", (body.scopeId,)).fetchone():
                return False
            connection.execute("INSERT INTO calendar_setting (calendar_id, scope_id, confidentiality, hidden) VALUES (?, ?, ?, ?) "
                               "ON CONFLICT (calendar_id) DO UPDATE SET scope_id = excluded.scope_id, confidentiality = excluded.confidentiality, "
                               "hidden = excluded.hidden", (calendar_id, body.scopeId, body.confidentiality, int(body.hidden)))
            return True
        return {"ok": True} if await db(work) else refuse("Ese ámbito no existe.")

    @router.get("/calendar/agenda")
    async def agenda(when: Literal["hoy", "mañana", "semana"] = "hoy"):
        store = calendar_store.shared()
        if problem := ready(store):
            return {"events": [], "reminders": [], "overlaps": [], "problem": problem}
        start, end = calendar_store.day_range(when)
        found = await db(lambda c: calendar_store.agenda(c, store, start, end))
        return {**found, "from": start.isoformat(), "to": end.isoformat(), "problem": None}

    def done(inbox_id: int | None) -> None:
        if inbox_id is not None:
            with database() as connection:
                mail_inbox.decide(connection, inbox_id, "done")

    @router.post("/calendar/events", status_code=201)
    async def create_event(body: EventIn):
        store = calendar_store.shared()
        if problem := ready(store):
            return refuse(problem, 409)
        if body.end <= body.start and not body.allDay:
            return refuse("El evento tiene que terminar después de empezar.")
        start, end = body.start.astimezone(), (body.end if body.end > body.start else body.start + timedelta(days=1)).astimezone()

        def check_and_create():
            existing = store.events(start - timedelta(days=1), end + timedelta(days=1))
            clash = [] if body.allDay else calendar_store.clashes(calendar_store._iso(start), calendar_store._iso(end), existing)
            if clash and not body.overlapOk:
                return None, clash
            made = store.create_event(body.calendarId, body.title.strip(), start, end, body.allDay, body.location, body.notes)
            done(body.inboxId)
            return made, clash
        try:
            made, clash = await run_in_threadpool(check_and_create)
        except calendar_store.CalendarError as error:
            return refuse(str(error))
        if made is None:
            return refuse("Se solapa con otros eventos: confírmalo si aun así lo quieres.", 409,
                          clashes=[{"title": e["title"], "start": e["start"], "end": e["end"]} for e in clash])
        return {"id": made, "clashes": len(clash)}

    @router.post("/calendar/reminders", status_code=201)
    async def create_reminder(body: ReminderIn):
        store = calendar_store.shared()
        if store.status()["reminders"] != "granted":
            return refuse("AgoraOne aún no tiene permiso para Recordatorios: dáselo en Ajustes › Calendarios.", 409)

        def create():
            made = store.create_reminder(body.calendarId, body.title.strip(), body.due.astimezone() if body.due else None, body.notes)
            done(body.inboxId)
            return made
        try:
            return {"id": await run_in_threadpool(create)}
        except calendar_store.CalendarError as error:
            return refuse(str(error))

    return router
