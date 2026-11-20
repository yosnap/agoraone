"""Clients are born in Central (user's decision, 20/11/2026): who writes or meets the user and is no client yet comes
up as a proposal «Crear cliente en Central», never created by itself (a mail or a message never triggers an action).

Proposals, only from what is «normal» (never «solo en este Mac» nor private) and only of what the core already keeps:
- mail: senders of messages classified as a client's or a job (`mail_summary.kind`), grouped by their domain when it
  may stand for one client (never a mail provider's nor a public suffix), else by their address; never the user's own;
- WhatsApp: conversations classified so (`chat_summary.kind`), by the participant's name and number;
- meetings: the client written on a meeting and its people with an address.
Anything the directory of clients already knows (by address, domain, number or name) is left out. The list never
carries an address nor a number (only the domain of a mail, as a hint): `proposal` gives the whole data to the core
for «Crear en Central», where the user sees it exactly before confirming. «Descartar» keeps only the key (a hash or
the conversation's id). Senders' names and texts are data, never instructions."""

import hashlib
import re
import sqlite3

from . import clients, meetings
from .db import now, transaction

KINDS = ("client", "job")
DAYS = 180
LIMIT = 200
UNNAMED = "Contacto de WhatsApp sin nombre"  # the user names it when ticking it
KEY = re.compile(r"^(?:mail|chat|meeting|person):[0-9a-f]{24}$|^chat:\d{1,12}$")


class BirthError(ValueError):
    pass


def _hash(value: str) -> str:
    return hashlib.sha256(value.casefold().encode()).hexdigest()[:24]


def _label(host: str) -> str:
    """«acme-studio.es» → «Acme Studio»: a proposed name the user sees before anything is created."""
    first = host.split(".")[0]
    return " ".join(part.capitalize() for part in re.split(r"[-_]+", first) if part) or host


def _all(connection: sqlite3.Connection) -> list[dict]:
    entries = clients.directory(connection)
    own = {r["address"].lower() for r in connection.execute("SELECT address FROM mail_account")}
    found: dict[str, dict] = {}

    def add(key: str, origin: str, name: str, hint: str | None, data: dict, at: str | None) -> None:
        item = found.get(key)
        if item is None:
            found[key] = {"key": key, "origin": origin, "name": name[:200], "hint": hint, "count": 1, "last": at, "_data": data}
        else:
            item["count"] += 1
            if at and (item["last"] or "") < at:
                item["last"] = at

    for row in connection.execute(
            "SELECT m.from_address AS address, m.from_name AS name, coalesce(m.sent_at, m.received_at) AS at FROM mail_message m "
            "JOIN mail_summary s ON s.message_id = m.id WHERE s.kind IN ('client', 'job') AND s.confidentiality = 'normal' "
            "AND coalesce(m.sent_at, m.received_at) >= datetime('now', ?) ORDER BY at DESC LIMIT 5000", (f"-{DAYS} days",)):
        address = (row["address"] or "").strip().lower()
        if "@" not in address or address in own or clients.find(entries, address=address):
            continue
        host = clients.domain(address)
        if clients.client_domain(host):
            name = _label(host)
            if clients._named(entries, name):
                continue
            add(f"mail:{_hash(host)}", "mail", name, host, {"name": name, "company": name, "email": address}, row["at"])
        else:
            name = " ".join((row["name"] or "").split()) or address.split("@")[0]
            if clients._named(entries, name):
                continue
            add(f"mail:{_hash(address)}", "mail", name, None, {"name": name, "email": address}, row["at"])

    for row in connection.execute(
            "SELECT c.id, c.participant_name AS name, c.participant_phone AS phone, c.last_incoming_at AS at FROM chat_conversation c "
            "JOIN chat_summary s ON s.conversation_id = c.id WHERE s.kind IN ('client', 'job') AND s.confidentiality = 'normal' "
            "ORDER BY c.last_incoming_at DESC LIMIT 2000"):
        phone = (row["phone"] or "").strip() or None
        name = " ".join((row["name"] or "").split())
        if not name or sum(c.isdigit() for c in name) >= 6:  # no name, or a number as its name: never shown on the list
            name = UNNAMED
        if (phone and clients.find(entries, phone=phone)) or (name != UNNAMED and clients._named(entries, name)):
            continue
        add(f"chat:{row['id']}", "whatsapp", name, None, {"name": name, "phone": phone}, row["at"])

    for row in connection.execute("SELECT client, people, started_at AS at FROM meeting WHERE confidentiality = 'normal' "
                                  "ORDER BY started_at DESC LIMIT 2000"):
        client = " ".join((row["client"] or "").split())
        if client and not clients._named(entries, client):
            add(f"meeting:{_hash(client)}", "meeting", client, None, {"name": client}, row["at"])
        for person in meetings.people_of(row["people"]):
            address = (person.get("email") or "").strip().lower()
            if "@" not in address or address in own or clients.find(entries, address=address):
                continue
            host = clients.domain(address)
            if clients.client_domain(host) and f"mail:{_hash(host)}" in found:
                add(f"mail:{_hash(host)}", "mail", "", None, {}, row["at"])  # already proposed by its domain: one more sign
                continue
            name = " ".join(str(person.get("name") or "").split()) or address.split("@")[0]
            if not clients._named(entries, name):
                add(f"person:{_hash(address)}", "meeting", name, host if clients.client_domain(host) else None, {"name": name, "email": address}, row["at"])
    return sorted(found.values(), key=lambda i: (-(i["count"]), i["name"].casefold()))


def build(connection: sqlite3.Connection, include_dismissed: bool = False) -> dict:
    """The proposals (without the dismissed ones unless asked), newest and most frequent first; never an address nor a number."""
    gone = {r["key"] for r in connection.execute("SELECT key FROM client_suggestion_dismissed")}
    items, hidden = [], 0
    for item in _all(connection):
        dismissed = item["key"] in gone
        hidden += dismissed
        if include_dismissed or not dismissed:
            items.append({**{k: v for k, v in item.items() if k != "_data"}, "dismissed": dismissed})
    return {"items": items[:LIMIT], "dismissed": hidden}


def proposal(connection: sqlite3.Connection, key: str) -> dict | None:
    """The whole proposed data of one proposal (for the core only: «Crear en Central» shows it before confirming)."""
    return next(({"name": i["name"], **i["_data"]} for i in _all(connection) if i["key"] == key), None)


def dismiss(connection: sqlite3.Connection, key: str, dismissed: bool) -> None:
    if not KEY.fullmatch(key or ""):
        raise BirthError("Propuesta no válida.")
    with transaction(connection):
        if dismissed:
            connection.execute("INSERT OR IGNORE INTO client_suggestion_dismissed (key, created_at) VALUES (?, ?)", (key, now()))
        else:
            connection.execute("DELETE FROM client_suggestion_dismissed WHERE key = ?", (key,))
