"""The user's macOS calendars and reminders through EventKit (every account macOS has: iCloud, Google,
Exchange…). Reading needs the user's permission, asked by the signed app; creating an event or a reminder
only happens after the user confirms it, and nothing is ever deleted. `FakeStore` stands in for EventKit in
tests and wherever it is missing."""

import threading
from datetime import datetime, timedelta, timezone

STATUS = {0: "undetermined", 1: "restricted", 2: "denied", 3: "granted", 4: "write_only"}
WAIT = 25  # seconds per macOS prompt: two prompts stay within the backend's 60 s limit


class CalendarError(RuntimeError):
    pass


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def overlaps(events: list[dict]) -> list[tuple[str, str]]:
    """Pairs of timed events (not all-day ones) that overlap: one starts before the other ends."""
    timed = sorted((e for e in events if not e.get("allDay")), key=lambda e: e["start"])
    found = []
    for i, first in enumerate(timed):
        for second in timed[i + 1:]:
            if second["start"] >= first["end"]:
                break
            found.append((first["id"], second["id"]))
    return found


def clashes(start: str, end: str, events: list[dict]) -> list[dict]:
    """The timed events a new one from `start` to `end` would overlap."""
    return [e for e in events if not e.get("allDay") and e["start"] < end and start < e["end"]]


class EventKitStore:
    """EventKit, through PyObjC. Each call is synchronous; EventKit's own callbacks are waited for."""

    def __init__(self):
        import EventKit

        self.kit = EventKit
        self.store = EventKit.EKEventStore.alloc().init()
        self.lock = threading.Lock()

    def status(self) -> dict:
        kit = self.kit
        return {"events": STATUS.get(kit.EKEventStore.authorizationStatusForEntityType_(kit.EKEntityTypeEvent), "undetermined"),
                "reminders": STATUS.get(kit.EKEventStore.authorizationStatusForEntityType_(kit.EKEntityTypeReminder), "undetermined")}

    def request(self) -> dict:
        """Asks macOS for full access to calendars and reminders (the prompt shows the app's own wording)."""
        for ask in (self.store.requestFullAccessToEventsWithCompletion_, self.store.requestFullAccessToRemindersWithCompletion_):
            done = threading.Event()
            ask(lambda granted, error: done.set())
            done.wait(WAIT)
        with self.lock:
            self.store = self.kit.EKEventStore.alloc().init()  # a new store sees the permission just granted
        return self.status()

    def calendars(self) -> list[dict]:
        kit, found = self.kit, []
        for kind, entity in (("event", kit.EKEntityTypeEvent), ("reminder", kit.EKEntityTypeReminder)):
            for calendar in self.store.calendarsForEntityType_(entity) or []:
                source = calendar.source()
                found.append({"id": str(calendar.calendarIdentifier()), "title": str(calendar.title() or ""), "kind": kind,
                              "account": str(source.title()) if source else "", "writable": bool(calendar.allowsContentModifications())})
        return found

    def events(self, start: datetime, end: datetime) -> list[dict]:
        from Foundation import NSDate

        predicate = self.store.predicateForEventsWithStartDate_endDate_calendars_(
            NSDate.dateWithTimeIntervalSince1970_(start.timestamp()), NSDate.dateWithTimeIntervalSince1970_(end.timestamp()), None)
        found = []
        for event in self.store.eventsMatchingPredicate_(predicate) or []:
            found.append({"id": str(event.eventIdentifier() or event.calendarItemIdentifier()), "calendarId": str(event.calendar().calendarIdentifier()),
                          "title": str(event.title() or ""), "start": _iso(datetime.fromtimestamp(event.startDate().timeIntervalSince1970(), timezone.utc)),
                          "end": _iso(datetime.fromtimestamp(event.endDate().timeIntervalSince1970(), timezone.utc)),
                          "allDay": bool(event.isAllDay()), "location": str(event.location() or "") or None})
        return found

    def reminders(self, until: datetime) -> list[dict]:
        """Reminders not done yet that are due before `until` or have no due date."""
        from Foundation import NSCalendar, NSDate

        predicate = self.store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars_(
            None, NSDate.dateWithTimeIntervalSince1970_(until.timestamp()), None)
        box, done = {}, threading.Event()

        def got(items):
            box["items"] = list(items or [])
            done.set()
        self.store.fetchRemindersMatchingPredicate_completion_(predicate, got)
        if not done.wait(WAIT):
            raise CalendarError("Recordatorios no respondió a tiempo.")
        found = []
        for reminder in box["items"]:
            components = reminder.dueDateComponents()
            day = NSCalendar.currentCalendar().dateFromComponents_(components) if components else None
            found.append({"id": str(reminder.calendarItemIdentifier()), "calendarId": str(reminder.calendar().calendarIdentifier()),
                          "title": str(reminder.title() or ""),
                          "due": _iso(datetime.fromtimestamp(day.timeIntervalSince1970(), timezone.utc)) if day else None})
        return found

    def _calendar(self, calendar_id: str | None, entity):
        calendar = self.store.calendarWithIdentifier_(calendar_id) if calendar_id else None
        if calendar is None:
            calendar = (self.store.defaultCalendarForNewEvents() if entity == self.kit.EKEntityTypeEvent
                        else self.store.defaultCalendarForNewReminders())
        if calendar is None or not calendar.allowsContentModifications():
            raise CalendarError("Ese calendario no admite cambios.")
        return calendar

    def create_event(self, calendar_id: str | None, title: str, start: datetime, end: datetime, all_day: bool,
                     location: str | None, notes: str | None) -> str:
        from Foundation import NSDate

        kit = self.kit
        event = kit.EKEvent.eventWithEventStore_(self.store)
        event.setCalendar_(self._calendar(calendar_id, kit.EKEntityTypeEvent))
        event.setTitle_(title)
        event.setStartDate_(NSDate.dateWithTimeIntervalSince1970_(start.timestamp()))
        event.setEndDate_(NSDate.dateWithTimeIntervalSince1970_(end.timestamp()))
        event.setAllDay_(all_day)
        if location:
            event.setLocation_(location)
        if notes:
            event.setNotes_(notes)
        ok, error = self.store.saveEvent_span_commit_error_(event, kit.EKSpanThisEvent, True, None)
        if not ok:
            raise CalendarError("macOS no dejó guardar el evento.")
        return str(event.eventIdentifier())

    def create_reminder(self, calendar_id: str | None, title: str, due: datetime | None, notes: str | None) -> str:
        from Foundation import NSCalendar, NSDate

        kit = self.kit
        reminder = kit.EKReminder.reminderWithEventStore_(self.store)
        reminder.setCalendar_(self._calendar(calendar_id, kit.EKEntityTypeReminder))
        reminder.setTitle_(title)
        if due:
            units = 4 | 8 | 16 | 32 | 64  # year, month, day, hour, minute
            reminder.setDueDateComponents_(NSCalendar.currentCalendar().components_fromDate_(units, NSDate.dateWithTimeIntervalSince1970_(due.timestamp())))
        if notes:
            reminder.setNotes_(notes)
        ok, error = self.store.saveReminder_commit_error_(reminder, True, None)
        if not ok:
            raise CalendarError("macOS no dejó guardar el recordatorio.")
        return str(reminder.calendarItemIdentifier())


class FakeStore:
    """An in-memory calendar for tests (and the state «not available» where EventKit is missing)."""

    def __init__(self, calendars=None, events=None, reminders=None, status="granted"):
        self.calendars_list = calendars or []
        self.events_list = events or []
        self.reminders_list = reminders or []
        self.state = status
        self.created: list[dict] = []

    def status(self) -> dict:
        return {"events": self.state, "reminders": self.state}

    def request(self) -> dict:
        return self.status()

    def calendars(self) -> list[dict]:
        return list(self.calendars_list)

    def events(self, start: datetime, end: datetime) -> list[dict]:
        return [e for e in self.events_list if e["start"] < _iso(end) and _iso(start) < e["end"]]

    def reminders(self, until: datetime) -> list[dict]:
        return [r for r in self.reminders_list if r.get("due") is None or r["due"] <= _iso(until)]

    def create_event(self, calendar_id, title, start, end, all_day, location, notes) -> str:
        item = {"id": f"ev{len(self.created) + 1}", "calendarId": calendar_id or "cal", "title": title, "start": _iso(start),
                "end": _iso(end), "allDay": all_day, "location": location}
        self.created.append(item)
        self.events_list.append(item)
        return item["id"]

    def create_reminder(self, calendar_id, title, due, notes) -> str:
        item = {"id": f"re{len(self.created) + 1}", "calendarId": calendar_id or "rem", "title": title, "due": _iso(due) if due else None}
        self.created.append(item)
        self.reminders_list.append(item)
        return item["id"]


def default_store():
    try:
        return EventKitStore()
    except Exception:  # noqa: BLE001 - not macOS, or PyObjC missing: the calendar says it is not available
        return FakeStore(status="unavailable")


def day_range(when: str, now: datetime | None = None) -> tuple[datetime, datetime]:
    """«hoy», «mañana» or «semana» in local time, as (start, end)."""
    now = (now or datetime.now()).astimezone()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = today + timedelta(days=1) if when == "mañana" else today
    return start, start + timedelta(days=7 if when == "semana" else 1)


_SHARED = None
_SHARED_LOCK = threading.Lock()


def shared():
    """The one store the core uses (EventKit, created on first use)."""
    global _SHARED
    with _SHARED_LOCK:
        if _SHARED is None:
            _SHARED = default_store()
        return _SHARED


def use(store) -> None:
    """Tests (and create_app) choose the store."""
    global _SHARED
    with _SHARED_LOCK:
        _SHARED = store


def settings(connection) -> dict[str, dict]:
    return {r["calendar_id"]: {"scopeId": r["scope_id"], "confidentiality": r["confidentiality"], "hidden": bool(r["hidden"])}
            for r in connection.execute("SELECT calendar_id, scope_id, confidentiality, hidden FROM calendar_setting")}


def agenda(connection, store, start: datetime, end: datetime, audience: str = "owner") -> dict:
    """Events and pending reminders between start and end, with overlaps. For an external audience (a remote
    model), only calendars marked normal; hidden calendars never."""
    chosen = settings(connection)

    def shown(item: dict) -> bool:
        setting = chosen.get(item["calendarId"], {})
        if setting.get("hidden"):
            return False
        return audience == "owner" or setting.get("confidentiality", "normal") == "normal"
    events = sorted((e for e in store.events(start, end) if shown(e)), key=lambda e: e["start"])
    reminders = [r for r in store.reminders(end) if shown(r)]
    return {"events": events, "reminders": reminders, "overlaps": overlaps(events)}
