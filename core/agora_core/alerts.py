"""Proactive reminders: missed calls not returned, meetings about to start, deadlines in the mail and the
morning summary. They become notifications (macOS's, or inside the app while it is in front), each one once
and never in quiet hours, and Watson's summary. Calls carry their own confidentiality: «solo este Mac» by
default, so they never reach a remote model unless the user says so; anything private shows on screen
without names or titles."""

import json
import sqlite3
import sys
from datetime import datetime, timedelta

from . import calendar_store, calls, mail_inbox
from .db import transaction

DEFAULTS = {"morning": "08:30", "quietFrom": "22:00", "quietTo": "08:00", "missedCalls": True, "meetings": True,
            "commitments": True, "summary": True, "callsLevel": "local_only"}
MEETING_AHEAD = timedelta(minutes=15)
CALL_WINDOW = timedelta(days=3)
MORNING_UNTIL = 12 * 60  # a summary not shown by noon (or three hours after its time) is not shown that day


def settings(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT value FROM setting WHERE key = 'alerts'").fetchone()
    saved = json.loads(row["value"]) if row else {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}


def save_settings(connection: sqlite3.Connection, changes: dict) -> dict:
    with transaction(connection):  # two quick changes never undo each other
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


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def _call_alerts(found_calls: list[dict], names: dict[str, str], now: datetime, private: bool) -> list[dict]:
    alerts = []
    for call in calls.missed_not_returned(found_calls):
        when = _local(call["at"])
        if now - when > CALL_WINDOW:
            continue
        who = names.get(calls.key_of(call["address"]) or "") or call["name"] or call["address"] or "número oculto"
        alerts.append({"key": f"call:{call['id']}", "kind": "call", "title": "Llamada perdida" if private else f"Llamada perdida de {who}",
                       "body": f"El {when.strftime('%d/%m a las %H:%M')}; aún no la has devuelto.", "at": call["at"]})
    return alerts


def collect(connection: sqlite3.Connection, now: datetime | None = None, store=None, call_reader=calls.read_calls,
            contacts=None, audience: str = "owner", respect: bool = True) -> dict:
    """What deserves a reminder now, plus what could not be read. Each source fails on its own. For an
    external audience (Watson's model) calls come only if marked normal, and calendars and mail only their
    normal part. `respect=False` (Watson's summary) ignores the notification switches and the summary's hour."""
    now = (now or datetime.now()).astimezone()
    chosen, problems, alerts = settings(connection), [], []
    wants = lambda key: chosen[key] or not respect  # noqa: E731
    store = store or calendar_store.shared()
    calls_shown = audience == "owner" or chosen["callsLevel"] == "normal"
    missed: list[dict] = []
    calls_problem = None
    if wants("missedCalls") and calls_shown:
        try:
            names = {}
            try:
                names = contacts.names() if contacts else {}
            except Exception:  # noqa: BLE001 - without names, the numbers
                problems.append("No se pudieron leer los Contactos.")
            missed = _call_alerts(call_reader(), names, now, private=chosen["callsLevel"] == "private")
        except calls.CallsUnavailable as error:
            problems.append(str(error))
            calls_problem = error.code
        except Exception:  # noqa: BLE001
            problems.append("No se pudo leer el historial de llamadas.")
    alerts += missed
    day = {"events": [], "reminders": [], "overlaps": []}
    soon: list[dict] = []
    levels = {}
    try:
        if store.status()["events"] == "granted":
            start, end = calendar_store.day_range("hoy", now)
            day = calendar_store.agenda(connection, store, start, end, audience=audience)
            # A meeting right after midnight belongs to tomorrow's agenda: the next minutes are asked apart.
            soon = calendar_store.agenda(connection, store, now, now + MEETING_AHEAD, audience=audience)["events"]
            levels = calendar_store.settings(connection)
    except Exception:  # noqa: BLE001
        problems.append("No se pudo leer el calendario.")
    if wants("meetings"):
        for event in soon:
            begins = _local(event["start"])
            if not event["allDay"] and now <= begins <= now + MEETING_AHEAD:
                private = levels.get(event["calendarId"], {}).get("confidentiality", "normal") == "private"
                alerts.append({"key": f"event:{event['id']}", "kind": "meeting",
                               "title": f"A las {begins.strftime('%H:%M')}: {'una reunión' if private else event['title']}",
                               "body": "Empieza en unos minutos." if private or not event.get("location") else event["location"], "at": event["start"]})
    pending: list[dict] = []
    try:
        pending = mail_inbox.inbox(connection, "pending", 200, audience="external" if audience == "external" else None)
    except Exception:  # noqa: BLE001
        problems.append("No se pudo leer la Bandeja.")
    if wants("commitments"):
        today, tomorrow = now.date().isoformat(), (now.date() + timedelta(days=1)).isoformat()
        for item in pending:
            for day_text in item["details"].get("dates", []) or []:
                if day_text in (today, tomorrow):
                    private = item.get("confidentiality") == "private"
                    who = item["from"]["name"] or item["from"]["address"] or "un correo"
                    alerts.append({"key": f"mail:{item['id']}:{day_text}", "kind": "commitment",
                                   "title": f"{'Hoy' if day_text == today else 'Mañana'}: {'plazo de un correo privado' if private else item['subject'] or 'plazo de un correo'}",
                                   "body": "Está en la Bandeja." if private else f"De {who}. Está en la Bandeja.", "at": day_text})
    morning = None
    minute = now.hour * 60 + now.minute
    start = _minutes(chosen["morning"])
    if wants("summary") and (not respect or start <= minute < max(MORNING_UNTIL, start + 180)):
        parts = [f"{len(day['events'])} en la agenda" + (f" ({_plural(len(day['overlaps']), 'solape')})" if day["overlaps"] else ""),
                 _plural(len(day["reminders"]), "recordatorio"), f"{len(pending)} en la Bandeja"]
        if calls_shown and wants("missedCalls") and calls_problem is None:
            parts.append(f"{_plural(len(missed), 'llamada')} sin devolver")
        morning = {"key": f"morning:{now.date().isoformat()}", "kind": "summary", "title": "Tu día en AgoraOne", "body": " · ".join(parts) + ".",
                   "at": now.date().isoformat()}
    return {"alerts": alerts, "morning": morning, "problems": problems, "callsProblem": calls_problem, "events": day["events"],
            "overlaps": day["overlaps"], "reminders": day["reminders"], "pending": len(pending), "missed": missed}


def due(connection: sqlite3.Connection, now: datetime | None = None, **sources) -> list[dict]:
    """The notifications to show now that were not shown yet; nothing in quiet hours. Nothing is marked here:
    whoever shows one confirms it with `ack`, so a notification that could not be shown comes back."""
    now = (now or datetime.now()).astimezone()
    if quiet(now, settings(connection)):
        return []
    try:
        found = collect(connection, now, **sources)
    except Exception as error:  # noqa: BLE001 - the next minute tries again
        print(f"AgoraOne núcleo: avisos en pausa ({type(error).__name__})", file=sys.stderr)
        return []
    candidates = found["alerts"] + ([found["morning"]] if found["morning"] else [])
    shown = {r["key"] for r in connection.execute("SELECT key FROM alert_delivered")}
    return [{"key": a["key"], "title": a["title"], "body": a["body"], "kind": a["kind"]} for a in candidates if a["key"] not in shown]


def ack(connection: sqlite3.Connection, keys: list[str], now: datetime | None = None) -> None:
    now = (now or datetime.now()).astimezone()
    stamp = now.isoformat(timespec="seconds")
    with transaction(connection):
        connection.executemany("INSERT OR IGNORE INTO alert_delivered (key, delivered_at) VALUES (?, ?)", [(k, stamp) for k in keys if 0 < len(k) <= 300])
        connection.execute("DELETE FROM alert_delivered WHERE delivered_at < ?", ((now - timedelta(days=30)).isoformat(timespec="seconds"),))
