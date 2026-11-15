"""Proactive reminders: missed calls not returned, meetings about to start, deadlines in the mail and the
morning summary. They become macOS notifications shown by the app (each one once, never in quiet hours)
and Watson's summary. Calls carry their own confidentiality: «solo este Mac» by default, so they never
reach a remote model unless the user says so."""

import json
import sqlite3
from datetime import datetime, timedelta

from . import calendar_store, calls, mail_inbox

DEFAULTS = {"morning": "08:30", "quietFrom": "22:00", "quietTo": "08:00", "missedCalls": True, "meetings": True,
            "commitments": True, "summary": True, "callsLevel": "local_only"}
MEETING_AHEAD = timedelta(minutes=15)
CALL_WINDOW = timedelta(days=3)


def settings(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT value FROM setting WHERE key = 'alerts'").fetchone()
    saved = json.loads(row["value"]) if row else {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}


def save_settings(connection: sqlite3.Connection, changes: dict) -> dict:
    merged = {**settings(connection), **{k: v for k, v in changes.items() if k in DEFAULTS}}
    connection.execute("INSERT INTO setting (key, value) VALUES ('alerts', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                       (json.dumps(merged),))
    return merged


def _minutes(text: str) -> int:
    hours, minutes = text.split(":")
    return int(hours) * 60 + int(minutes)


def quiet(now: datetime, chosen: dict) -> bool:
    """Inside the quiet hours (which may cross midnight: 22:00–08:00)."""
    at, start, end = now.hour * 60 + now.minute, _minutes(chosen["quietFrom"]), _minutes(chosen["quietTo"])
    return start <= at < end if start <= end else at >= start or at < end


def _local(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()


def _call_alerts(found_calls: list[dict], names: dict[str, str], now: datetime) -> list[dict]:
    alerts = []
    for call in calls.missed_not_returned(found_calls):
        when = _local(call["at"])
        if now - when > CALL_WINDOW:
            continue
        who = names.get(calls.key_of(call["address"]) or "") or call["name"] or call["address"] or "número oculto"
        alerts.append({"key": f"call:{call['id']}", "kind": "call", "title": f"Llamada perdida de {who}",
                       "body": f"El {when.strftime('%d/%m a las %H:%M')}; aún no la has devuelto.", "at": call["at"]})
    return alerts


def collect(connection: sqlite3.Connection, now: datetime | None = None, store=None, call_reader=calls.read_calls,
            contacts=None, audience: str = "owner") -> dict:
    """What deserves a reminder now, plus anything that could not be read. For an external audience (Watson's
    model) calls come only if the user marked them normal, and calendars and mail only their normal part."""
    now = (now or datetime.now()).astimezone()
    chosen, problems, alerts = settings(connection), [], []
    store = store or calendar_store.shared()
    calls_shown = audience == "owner" or chosen["callsLevel"] == "normal"
    missed: list[dict] = []
    if chosen["missedCalls"] and calls_shown:
        try:
            missed = _call_alerts(call_reader(), (contacts.names() if contacts else {}), now)
        except calls.CallsUnavailable as error:
            problems.append(str(error))
    alerts += missed
    events: list[dict] = []
    if store.status()["events"] == "granted":
        try:
            start, end = calendar_store.day_range("hoy", now)
            day = calendar_store.agenda(connection, store, start, end, audience=audience)
            events = day["events"]
        except calendar_store.CalendarError as error:
            problems.append(str(error))
            day = {"events": [], "reminders": [], "overlaps": []}
    else:
        day = {"events": [], "reminders": [], "overlaps": []}
    if chosen["meetings"]:
        for event in events:
            begins = _local(event["start"])
            if not event["allDay"] and now <= begins <= now + MEETING_AHEAD:
                alerts.append({"key": f"event:{event['id']}", "kind": "meeting", "title": f"A las {begins.strftime('%H:%M')}: {event['title']}",
                               "body": event.get("location") or "Empieza en unos minutos.", "at": event["start"]})
    pending = mail_inbox.inbox(connection, "pending", 200, audience="owner" if audience == "owner" else "external")
    if chosen["commitments"]:
        today, tomorrow = now.date().isoformat(), (now.date() + timedelta(days=1)).isoformat()
        for item in pending:
            for day_text in item["details"].get("dates", []) or []:
                if day_text in (today, tomorrow):
                    who = item["from"]["name"] or item["from"]["address"] or "un correo"
                    alerts.append({"key": f"mail:{item['id']}:{day_text}", "kind": "commitment",
                                   "title": f"{'Hoy' if day_text == today else 'Mañana'}: {item['subject'] or 'plazo de un correo'}",
                                   "body": f"De {who}. Está en la Bandeja.", "at": day_text})
    morning = None
    if chosen["summary"] and now.hour * 60 + now.minute >= _minutes(chosen["morning"]):
        parts = [f"{len(events)} en la agenda" + (f" ({len(day['overlaps'])} solape{'s' if len(day['overlaps']) != 1 else ''})" if day["overlaps"] else ""),
                 f"{len(day['reminders'])} recordatorio{'s' if len(day['reminders']) != 1 else ''}",
                 f"{len(pending)} en la Bandeja"]
        if calls_shown and chosen["missedCalls"]:
            parts.append(f"{len(missed)} llamada{'s' if len(missed) != 1 else ''} sin devolver")
        morning = {"key": f"morning:{now.date().isoformat()}", "kind": "summary", "title": "Tu día en AgoraOne", "body": " · ".join(parts) + ".",
                   "at": now.date().isoformat()}
    return {"alerts": alerts, "morning": morning, "problems": problems, "events": events, "overlaps": day["overlaps"],
            "reminders": day["reminders"], "pending": len(pending), "missed": missed}


def claim(connection: sqlite3.Connection, now: datetime | None = None, **sources) -> list[dict]:
    """The notifications to show now, each one once: nothing in quiet hours (a summary or a deadline waits for
    them to end; a meeting that already started is not shown late)."""
    now = (now or datetime.now()).astimezone()
    if quiet(now, settings(connection)):
        return []
    found = collect(connection, now, **sources)
    due = found["alerts"] + ([found["morning"]] if found["morning"] else [])
    delivered = {r["key"] for r in connection.execute("SELECT key FROM alert_delivered")}
    fresh = [a for a in due if a["key"] not in delivered]
    stamp = now.isoformat(timespec="seconds")
    connection.executemany("INSERT OR IGNORE INTO alert_delivered (key, delivered_at) VALUES (?, ?)", [(a["key"], stamp) for a in fresh])
    connection.execute("DELETE FROM alert_delivered WHERE delivered_at < ?", ((now - timedelta(days=30)).isoformat(timespec="seconds"),))
    return [{"title": a["title"], "body": a["body"], "kind": a["kind"]} for a in fresh]
