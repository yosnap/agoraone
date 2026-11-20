"""HTTP routes of the calendar: permission, calendars and their scope and confidentiality, the agenda with
overlaps, and creating an event or a reminder, only after the user confirms it in the app (never deleting)."""

import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool, StrictInt

from . import calendar_edit, calendar_store, chat_inbox, mail_inbox
from .db import DB_NAME, connect
from .settings import Settings
from . import system_words

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
    chatId: StrictInt | None = None  # or the WhatsApp conversation's card (never both)


class EventChange(BaseModel):
    id: Annotated[str, Field(min_length=1, max_length=400)]
    revision: Annotated[str, Field(min_length=1, max_length=64)]
    title: Annotated[str, Field(min_length=1, max_length=1000)]
    start: datetime
    end: datetime
    allDay: StrictBool = False
    location: Annotated[str, Field(max_length=2000)] | None = None
    notes: Annotated[str, Field(max_length=100_000)] | None = None  # meeting invitations bring long notes
    overlapOk: StrictBool = False


class ReminderIn(BaseModel):
    calendarId: Annotated[str, Field(max_length=200)] | None = None
    title: Annotated[str, Field(min_length=1, max_length=200)]
    due: datetime | None = None
    notes: Annotated[str, Field(max_length=4000)] | None = None
    inboxId: StrictInt | None = None
    chatId: StrictInt | None = None


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
            return "El calendario de macOS no está disponible aquí." if system_words.MAC else "La agenda todavía no está disponible en este sistema."
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
    async def agenda(when: Literal["hoy", "mañana", "semana"] = "hoy", first: date | None = Query(default=None, alias="from"),
                     last: date | None = Query(default=None, alias="to")):
        """«hoy», «mañana» or «semana», or any period from `from` to `to` (local days, both included) for the
        calendar views (day, week, month, year)."""
        store = calendar_store.shared()
        if problem := ready(store):
            return {"events": [], "reminders": [], "overlaps": [], "problem": problem,
                    "unavailable": store.status()["events"] == "unavailable"}
        if (first is None) != (last is None):
            return JSONResponse({"error": "Indica «from» y «to» juntos."}, status_code=422)
        try:
            start, end = calendar_store.dates_range(first, last) if first and last else calendar_store.day_range(when)
        except calendar_store.CalendarError as error:
            return JSONResponse({"error": str(error)}, status_code=422)
        try:
            found = await db(lambda c: calendar_store.agenda(c, store, start, end, describe=True))
        except calendar_store.CalendarError as error:
            return {"events": [], "reminders": [], "overlaps": [], "problem": str(error)}
        return {**found, "from": start.isoformat(), "to": end.isoformat(), "problem": None}

    def origin_problem(body) -> str | None:
        """A card is one mail or one conversation, never both (their ids are different spaces); a conversation must
        still be in the Bandeja before anything is created."""
        if body.inboxId is not None and body.chatId is not None:
            return "El evento sale de un correo o de una conversación, no de los dos."
        if body.chatId is None:
            return None
        try:
            with database() as connection:
                chat_inbox.level_of(connection, body.chatId)
        except chat_inbox.ChatGone as error:
            return str(error)
        return None

    def done(body) -> None:
        """Marks the Bandeja card done; the event already exists, so a failure here must not look like the
        creation failed (trying again would create it twice)."""
        if body.inboxId is None and body.chatId is None:
            return
        try:
            with database() as connection:
                if body.chatId is not None:
                    chat_inbox.decide(connection, body.chatId, "done")
                else:
                    mail_inbox.decide(connection, body.inboxId, "done")
        except Exception:  # noqa: BLE001
            pass

    @router.post("/calendar/events", status_code=201)
    async def create_event(body: EventIn):
        store = calendar_store.shared()
        if problem := ready(store):
            return refuse(problem, 409)
        if body.end <= body.start and not body.allDay:
            return refuse("El evento tiene que terminar después de empezar.")
        start, end = body.start.astimezone(), (body.end if body.end > body.start else body.start + timedelta(days=1)).astimezone()
        if problem := await run_in_threadpool(origin_problem, body):
            return refuse(problem)

        def check_and_create():
            with database() as connection:  # a clash never names an event of a hidden calendar
                existing = calendar_edit.visible_events(connection, store, start - timedelta(days=1), end + timedelta(days=1))
            clash = [] if body.allDay else calendar_store.clashes(calendar_store._iso(start), calendar_store._iso(end), existing)
            if clash and not body.overlapOk:
                return None, clash
            made = store.create_event(body.calendarId, body.title.strip(), start, end, body.allDay, body.location, body.notes)
            done(body)
            return made, clash
        try:
            made, clash = await run_in_threadpool(check_and_create)
        except calendar_store.CalendarError as error:
            return refuse(str(error))
        except Exception:  # noqa: BLE001 - EventKit failing says so
            return refuse("macOS no dejó guardar el evento.")
        if made is None:
            return refuse("Se solapa con otros eventos: confírmalo si aun así lo quieres.", 409,
                          clashes=[{"title": e["title"], "start": e["start"], "end": e["end"]} for e in clash])
        return {"id": made, "clashes": len(clash)}

    @router.get("/calendar/event")
    async def event_detail(event_id: str = Query(alias="id", min_length=1, max_length=400)):
        """One event whole (notes, video-call links, people) and whether the user may change it here."""
        store = calendar_store.shared()
        if problem := ready(store):
            return refuse(problem, 409)
        try:
            return await db(lambda c: calendar_edit.shown(c, store, event_id))
        except calendar_store.CalendarError as error:
            return refuse(str(error), 404)
        except Exception:  # noqa: BLE001 - EventKit failing says so
            return refuse("No se pudo leer el evento.")

    @router.put("/calendar/event")
    async def event_change(body: EventChange):
        """Changes one of the user's own events (that occurrence only), as they confirmed it; warns of clashes first."""
        store = calendar_store.shared()
        if problem := ready(store):
            return refuse(problem, 409)
        if body.end <= body.start and not body.allDay:
            return refuse("El evento tiene que terminar después de empezar.")
        start, end = body.start.astimezone(), (body.end if body.end > body.start else body.start + timedelta(days=1)).astimezone()
        changes = {"title": body.title.strip(), "startAt": start, "endAt": end, "allDay": body.allDay,
                   "location": (body.location or "").strip() or None, "notes": body.notes or None}

        def work(connection):
            calendar_edit.allowed(connection, store, body.id, body.revision)  # refused before any clash is named
            existing = [e for e in calendar_edit.visible_events(connection, store, start - timedelta(days=1), end + timedelta(days=1)) if e["id"] != body.id]
            clash = [] if body.allDay else calendar_store.clashes(calendar_store._iso(start), calendar_store._iso(end), existing)
            if clash and not body.overlapOk:
                return None, clash
            return calendar_edit.change(connection, store, body.id, body.revision, changes), clash
        try:
            made, clash = await db(work)
        except calendar_store.StaleEvent as error:
            return refuse(str(error), 409)
        except calendar_store.CalendarError as error:
            return refuse(str(error))
        except Exception:  # noqa: BLE001
            return refuse("macOS no dejó guardar el cambio.")
        if made is None:
            return refuse("Se solapa con otros eventos: confírmalo si aun así lo quieres.", 409,
                          clashes=[{"title": e["title"], "start": e["start"], "end": e["end"]} for e in clash])
        return {**made, "clashes": len(clash)}

    @router.post("/calendar/reminders", status_code=201)
    async def create_reminder(body: ReminderIn):
        store = calendar_store.shared()
        if store.status()["reminders"] != "granted":
            return refuse("AgoraOne aún no tiene permiso para Recordatorios: dáselo en Ajustes › Calendarios.", 409)
        if problem := await run_in_threadpool(origin_problem, body):
            return refuse(problem)

        def create():
            made = store.create_reminder(body.calendarId, body.title.strip(), body.due.astimezone() if body.due else None, body.notes)
            done(body)
            return made
        try:
            return {"id": await run_in_threadpool(create)}
        except calendar_store.CalendarError as error:
            return refuse(str(error))
        except Exception:  # noqa: BLE001
            return refuse("macOS no dejó guardar el recordatorio.")

    return router
