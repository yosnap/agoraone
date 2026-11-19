"""Seeing an event whole and changing the user's own (user's decision, 14/11/2026: changing calendar events only
after confirmation, with a copy first). An event may be changed when its calendar allows it and nobody else
organises it (an invitation belongs to its organiser); only that occurrence changes, never the rest of a repeating
event; the change is refused if the event changed since the user saw it; and nothing is ever deleted."""

import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from urllib.parse import urlsplit

from . import calendar_store
from .calendar_store import CalendarError, StaleEvent

_CHANGING = threading.Lock()  # one change at a time: two saves of the same revision cannot both pass the check

_URL = re.compile(r"https?://[^\s<>\"')\]\\]{4,500}", re.I)  # never «\»: browsers read it as «/», so the host would differ
MEETINGS = ((re.compile(r"(^|\.)meet\.google\.com$"), "Google Meet"), (re.compile(r"(^|\.)zoom\.us$"), "Zoom"),
            (re.compile(r"^teams\.(microsoft|live)\.com$"), "Microsoft Teams"), (re.compile(r"(^|\.)webex\.com$"), "Webex"),
            (re.compile(r"(^|\.)whereby\.com$"), "Whereby"), (re.compile(r"^meet\.jit\.si$"), "Jitsi"), (re.compile(r"^facetime\.apple\.com$"), "FaceTime"))


def links(detail: dict) -> list[dict]:
    """Every web address of the event (its URL, place and notes), the video-call ones first and named."""
    found: list[dict] = []
    for text in (detail.get("url"), detail.get("location"), detail.get("notes")):
        for match in _URL.finditer(text or ""):
            url = match[0].rstrip(".,;:")
            if url in (f["url"] for f in found):
                continue
            try:
                host = (urlsplit(url).hostname or "").lower()
            except ValueError:
                continue
            found.append({"url": url, "meeting": next((name for pattern, name in MEETINGS if pattern.search(host)), None)})
    return sorted(found, key=lambda f: f["meeting"] is None)[:20]


def why_not(detail: dict) -> str | None:
    """Why the user cannot change this event here, or None."""
    if not detail.get("writable"):
        return "Su calendario no admite cambios (es de solo lectura o de una suscripción)."
    organizer = detail.get("organizer")
    if organizer and not organizer.get("me"):  # even when the account hides the guest list
        return f"Es una invitación de {organizer.get('name') or organizer.get('email') or 'otra persona'}: solo quien la organiza puede cambiarla."
    return None


def shown(connection: sqlite3.Connection, store, event_id: str) -> dict:
    detail = store.detail(event_id)
    if calendar_store.settings(connection).get(detail["calendarId"], {}).get("hidden"):
        raise CalendarError("Ese calendario está oculto en Ajustes.")
    reason = why_not(detail)
    return {**detail, "links": links(detail), "editable": reason is None, "why": reason, "revision": calendar_store.revision(detail)}


def allowed(connection: sqlite3.Connection, store, event_id: str, revision: str) -> dict:
    """The event as it is, if the user may change it and it is as they saw it; raises saying why not otherwise."""
    before = shown(connection, store, event_id)
    if not before["editable"]:
        raise CalendarError(before["why"])
    if revision != before["revision"]:
        raise StaleEvent("El evento ha cambiado desde que lo abriste (aquí o en otro sitio): vuelve a abrirlo para ver cómo está.")
    return before


def visible_events(connection: sqlite3.Connection, store, start, end) -> list[dict]:
    """The events of the calendars that are not hidden: the only ones a clash may name."""
    hidden = {k for k, v in calendar_store.settings(connection).items() if v.get("hidden")}
    return [e for e in store.events(start, end) if e["calendarId"] not in hidden]


def change(connection: sqlite3.Connection, store, event_id: str, revision: str, changes: dict) -> dict:
    """Changes the event after checking it may be changed and is as the user saw it; keeps what it was first."""
    with _CHANGING:
        return _change(connection, store, event_id, revision, changes)


def _change(connection: sqlite3.Connection, store, event_id: str, revision: str, changes: dict) -> dict:
    before = allowed(connection, store, event_id, revision)
    after = {"title": changes["title"], "start": calendar_store._iso(changes["startAt"]), "end": calendar_store._iso(changes["endAt"]),
             "allDay": changes["allDay"], "location": changes["location"], "notes": changes["notes"]}
    kept = connection.execute("INSERT INTO calendar_change (event_id, before, after, changed_at) VALUES (?, ?, ?, ?)",
                              (event_id, json.dumps({k: before.get(k) for k in calendar_store.FIELDS}, ensure_ascii=False),
                               json.dumps(after, ensure_ascii=False), datetime.now(timezone.utc).isoformat(timespec="seconds"))).lastrowid
    connection.commit()  # the copy exists before the calendar is touched
    store.update(event_id, changes, revision)
    connection.execute("UPDATE calendar_change SET applied = 1 WHERE id = ?", (kept,))
    connection.commit()
    ident, at, _ = event_id.rpartition("@")
    return {"id": f"{ident}@{after['start']}" if at else event_id}  # an occurrence's id says when it starts
