"""The user's macOS calendars and reminders through EventKit (every account macOS has: iCloud, Google,
Exchange…). Reading needs the user's permission, asked by the signed app; creating an event or a reminder
only happens after the user confirms it, and nothing is ever deleted. `FakeStore` stands in for EventKit in
tests and wherever it is missing."""

import threading
from datetime import date, datetime, timedelta, timezone

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
        self.seen = self.status()  # what the store was created with: a permission granted later needs a new one

    def _fresh(self):
        """The store, renewed when the permission changed since it was made (granted in System Settings, or a
        prompt answered after the wait): an old store keeps seeing nothing."""
        now = self.status()
        with self.lock:
            if now != self.seen:
                self.store, self.seen = self.kit.EKEventStore.alloc().init(), now
            return self.store

    def status(self) -> dict:
        kit = self.kit
        return {"events": STATUS.get(kit.EKEventStore.authorizationStatusForEntityType_(kit.EKEntityTypeEvent), "undetermined"),
                "reminders": STATUS.get(kit.EKEventStore.authorizationStatusForEntityType_(kit.EKEntityTypeReminder), "undetermined")}

    def request(self) -> dict:
        """Asks macOS for full access to calendars and reminders (the prompt shows the app's own wording)."""
        kit, store = self.kit, self.store
        if hasattr(store, "requestFullAccessToEventsWithCompletion_"):  # macOS 14 and later
            asks = [store.requestFullAccessToEventsWithCompletion_, store.requestFullAccessToRemindersWithCompletion_]
        else:  # macOS 13
            asks = [lambda done: store.requestAccessToEntityType_completion_(kit.EKEntityTypeEvent, done),
                    lambda done: store.requestAccessToEntityType_completion_(kit.EKEntityTypeReminder, done)]
        for ask in asks:
            done = threading.Event()
            ask(lambda granted, error: done.set())
            done.wait(WAIT)
        self._fresh()
        return self.status()

    def calendars(self) -> list[dict]:
        kit, found = self.kit, []
        for kind, entity in (("event", kit.EKEntityTypeEvent), ("reminder", kit.EKEntityTypeReminder)):
            for calendar in self._fresh().calendarsForEntityType_(entity) or []:
                source = calendar.source()
                found.append({"id": str(calendar.calendarIdentifier()), "title": str(calendar.title() or ""), "kind": kind,
                              "account": str(source.title()) if source else "", "writable": bool(calendar.allowsContentModifications())})
        return found

    def events(self, start: datetime, end: datetime) -> list[dict]:
        from Foundation import NSDate

        store = self._fresh()
        predicate = store.predicateForEventsWithStartDate_endDate_calendars_(
            NSDate.dateWithTimeIntervalSince1970_(start.timestamp()), NSDate.dateWithTimeIntervalSince1970_(end.timestamp()), None)
        found = []
        for event in store.eventsMatchingPredicate_(predicate) or []:
            begins = _iso(datetime.fromtimestamp(event.startDate().timeIntervalSince1970(), timezone.utc))
            # Every occurrence of a repeating event shares its identifier: one id per occurrence.
            found.append({"id": f"{event.eventIdentifier() or event.calendarItemIdentifier()}@{begins}", "calendarId": str(event.calendar().calendarIdentifier()),
                          "title": str(event.title() or ""), "start": begins,
                          "end": _iso(datetime.fromtimestamp(event.endDate().timeIntervalSince1970(), timezone.utc)),
                          "allDay": bool(event.isAllDay()), "location": str(event.location() or "") or None})
        return found

    def reminders(self, until: datetime) -> list[dict]:
        """Reminders not done yet that are due before `until` or have no due date."""
        from Foundation import NSCalendar

        store = self._fresh()
        # With an end date EventKit leaves out the reminders that have none: ask for all, filter here.
        predicate = store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars_(None, None, None)
        box, done = {}, threading.Event()

        def got(items):
            box["items"] = list(items or [])
            done.set()
        store.fetchRemindersMatchingPredicate_completion_(predicate, got)
        if not done.wait(WAIT):
            raise CalendarError("Recordatorios no respondió a tiempo.")
        found = []
        for reminder in box["items"]:
            components = reminder.dueDateComponents()
            day = NSCalendar.currentCalendar().dateFromComponents_(components) if components else None
            due = _iso(datetime.fromtimestamp(day.timeIntervalSince1970(), timezone.utc)) if day else None
            if due is None or due <= _iso(until):
                found.append({"id": str(reminder.calendarItemIdentifier()), "calendarId": str(reminder.calendar().calendarIdentifier()),
                              "title": str(reminder.title() or ""), "due": due})
        return found

    def _calendar(self, calendar_id: str | None, entity):
        store = self._fresh()
        calendar = store.calendarWithIdentifier_(calendar_id) if calendar_id else None
        if calendar_id and calendar is None:
            raise CalendarError("Ese calendario ya no existe en macOS.")
        if calendar is None:
            calendar = (store.defaultCalendarForNewEvents() if entity == self.kit.EKEntityTypeEvent
                        else store.defaultCalendarForNewReminders())
        if calendar is None or not calendar.allowsContentModifications():
            raise CalendarError("Ese calendario no admite cambios.")
        return calendar

    def create_event(self, calendar_id: str | None, title: str, start: datetime, end: datetime, all_day: bool,
                     location: str | None, notes: str | None) -> str:
        from Foundation import NSDate

        kit = self.kit
        event = kit.EKEvent.eventWithEventStore_(self._fresh())
        event.setCalendar_(self._calendar(calendar_id, kit.EKEntityTypeEvent))
        event.setTitle_(title)
        event.setStartDate_(NSDate.dateWithTimeIntervalSince1970_(start.timestamp()))
        event.setEndDate_(NSDate.dateWithTimeIntervalSince1970_(end.timestamp()))
        event.setAllDay_(all_day)
        if location:
            event.setLocation_(location)
        if notes:
            event.setNotes_(notes)
        ok, error = self._fresh().saveEvent_span_commit_error_(event, kit.EKSpanThisEvent, True, None)
        if not ok:
            raise CalendarError("macOS no dejó guardar el evento.")
        return str(event.eventIdentifier())

    def create_reminder(self, calendar_id: str | None, title: str, due: datetime | None, notes: str | None) -> str:
        from Foundation import NSCalendar, NSDate

        kit = self.kit
        reminder = kit.EKReminder.reminderWithEventStore_(self._fresh())
        reminder.setCalendar_(self._calendar(calendar_id, kit.EKEntityTypeReminder))
        reminder.setTitle_(title)
        if due:
            units = 4 | 8 | 16 | 32 | 64  # year, month, day, hour, minute
            moment = NSDate.dateWithTimeIntervalSince1970_(due.timestamp())
            reminder.setDueDateComponents_(NSCalendar.currentCalendar().components_fromDate_(units, moment))
            reminder.addAlarm_(kit.EKAlarm.alarmWithAbsoluteDate_(moment))  # without an alarm, a due date does not notify
        if notes:
            reminder.setNotes_(notes)
        ok, error = self._fresh().saveReminder_commit_error_(reminder, True, None)
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
    today = (now or datetime.now()).astimezone().date()
    first = today + timedelta(days=1) if when == "mañana" else today
    last = first + timedelta(days=7 if when == "semana" else 1)
    # Midnight of each day in local time, so a day with a clock change still runs from midnight to midnight.
    midnight = lambda day: datetime(day.year, day.month, day.day).astimezone()  # noqa: E731
    return midnight(first), midnight(last)


MAX_RANGE_DAYS = 400  # a year view and a little margin


def dates_range(first: date, last: date) -> tuple[datetime, datetime]:
    """From the start of `first` to the end of `last` (both included), local midnights; at most MAX_RANGE_DAYS."""
    if last < first or (last - first).days >= MAX_RANGE_DAYS or not 1900 <= first.year <= 9998 or not 1900 <= last.year <= 9998:
        raise CalendarError(f"Elige un periodo de hasta {MAX_RANGE_DAYS} días.")
    midnight = lambda day: datetime(day.year, day.month, day.day).astimezone()  # noqa: E731
    return midnight(first), midnight(last + timedelta(days=1))


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


def agenda(connection, store, start: datetime, end: datetime, audience: str = "owner", describe: bool = False) -> dict:
    """Events and pending reminders between start and end, with overlaps. For an external audience (a remote
    model), only calendars marked normal; hidden calendars never."""
    chosen = settings(connection)

    def shown(item: dict) -> bool:
        setting = chosen.get(item["calendarId"], {})
        if setting.get("hidden"):
            return False
        return audience == "owner" or setting.get("confidentiality", "normal") == "normal"
    try:
        events = sorted((e for e in store.events(start, end) if shown(e)), key=lambda e: e["start"])
        reminders = [r for r in store.reminders(end) if shown(r)] if store.status()["reminders"] == "granted" else []
    except CalendarError:
        raise
    except Exception as error:  # noqa: BLE001 - EventKit or PyObjC failing says so instead of breaking the page
        raise CalendarError("No se pudo leer el calendario de macOS.") from error
    if describe and audience == "owner":  # for the Agenda screen only: whose calendar, which account and which scope
        try:
            known = {c["id"]: c for c in store.calendars()}
            scopes = {r["id"]: {"name": r["name"], "color": r["color"]} for r in connection.execute("SELECT id, name, color FROM scope")}
        except Exception:  # noqa: BLE001 - the names are a help, never a reason to fail
            known, scopes = {}, {}
        events, reminders = [dict(e) for e in events], [dict(r) for r in reminders]  # copies: the store's own items stay as they are
        for item in [*events, *reminders]:
            calendar = known.get(item["calendarId"], {})
            item["calendar"] = calendar.get("title") or None
            item["account"] = calendar.get("account") or None
            item["scope"] = scopes.get(chosen.get(item["calendarId"], {}).get("scopeId"))
    return {"events": events, "reminders": reminders, "overlaps": overlaps(events)}
