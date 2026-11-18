"""The phone calls the Mac keeps in sync with the iPhone (CallHistory, read-only, once the user gives the app
Full Disk Access) and the names from Contacts (its own macOS permission). The call database is copied first
and the copy is read, so macOS's own file is never locked or written."""

import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB = Path.home() / "Library" / "Application Support" / "CallHistoryDB" / "CallHistory.storedata"
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)  # Core Data dates count seconds from here
CONTACTS_TTL = 600


class CallsUnavailable(RuntimeError):
    """`code`: «permission» (no Full Disk Access), «missing» (no call history on this Mac) or «unreadable»."""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


_LAST: dict = {}  # the last reading, kept while the database does not change (it is read every minute)


def key_of(address: str | None) -> str | None:
    """One spelling per number or address: the last nine digits of a phone (+34 600… and 600… match), or
    the address in lower case."""
    if not address:
        return None
    if "@" in address:
        return address.strip().lower()
    digits = re.sub(r"\D", "", address)
    return digits[-9:] if len(digits) >= 6 else None


def read_calls(days: int = 7, db: Path = DB) -> list[dict]:
    """The calls of the last `days`, newest first, from a copy of the database and its write-ahead log (the
    shared-memory file is left out: SQLite rebuilds it). A copy taken while macOS writes may come out
    inconsistent, so it is tried twice."""
    if db == DB and sys.platform != "darwin":
        raise CallsUnavailable("El historial de llamadas sincronizado con iPhone solo está disponible en macOS.", "unavailable")
    try:
        stamp = tuple(Path(f"{db}{suffix}").stat().st_mtime_ns if Path(f"{db}{suffix}").exists() else 0 for suffix in ("", "-wal"))
    except PermissionError as error:
        raise CallsUnavailable("AgoraOne no puede leer el historial de llamadas: dale «Acceso total al disco» en Ajustes del Sistema.", "permission") from error
    except OSError as error:
        raise CallsUnavailable("Este Mac no tiene historial de llamadas.", "missing") from error
    if stamp == (0, 0):
        raise CallsUnavailable("Este Mac no tiene historial de llamadas.", "missing")
    if _LAST.get("key") == (str(db), days, stamp):
        return _LAST["calls"]
    for attempt in range(2):
        try:
            with tempfile.TemporaryDirectory() as work:
                copy = Path(work) / "calls.sqlite"
                shutil.copyfile(db, copy)
                if Path(f"{db}-wal").exists():
                    shutil.copyfile(f"{db}-wal", f"{copy}-wal")
                connection = sqlite3.connect(copy)
                try:
                    found = _rows(connection, days)
                finally:
                    connection.close()
            _LAST.update(key=(str(db), days, stamp), calls=found)
            return found
        except PermissionError as error:
            raise CallsUnavailable("AgoraOne no puede leer el historial de llamadas: dale «Acceso total al disco» en Ajustes del Sistema.", "permission") from error
        except FileNotFoundError as error:
            raise CallsUnavailable("Este Mac no tiene historial de llamadas.", "missing") from error
        except (OSError, sqlite3.DatabaseError) as error:
            if attempt:
                raise CallsUnavailable("No se pudo leer el historial de llamadas (formato desconocido o base dañada).", "unreadable") from error
    raise CallsUnavailable("No se pudo leer el historial de llamadas.", "unreadable")


def _rows(connection: sqlite3.Connection, days: int) -> list[dict]:
    columns = {row[1].upper() for row in connection.execute("PRAGMA table_info(ZCALLRECORD)")}
    if not {"ZDATE", "ZADDRESS", "ZORIGINATED", "ZANSWERED"} <= columns:
        raise sqlite3.DatabaseError("unknown CallHistory layout")
    pick = lambda name, fallback="NULL": name if name in columns else fallback  # noqa: E731
    since = (datetime.now(timezone.utc) - timedelta(days=days) - APPLE_EPOCH).total_seconds()
    found = []
    for row in connection.execute(
            f"SELECT Z_PK, ZDATE, {pick('ZDURATION', '0')}, ZADDRESS, ZORIGINATED, ZANSWERED, {pick('ZNAME')}, {pick('ZUNIQUE_ID')} "
            "FROM ZCALLRECORD WHERE ZDATE >= ? ORDER BY ZDATE DESC LIMIT 2000", (since,)):
        pk, stamp, duration, address, originated, answered, name, unique = row
        if isinstance(address, bytes):
            address = address.decode("utf-8", "replace")
        found.append({"id": str(unique or pk), "at": (APPLE_EPOCH + timedelta(seconds=float(stamp))).isoformat(timespec="seconds"),
                      "duration": round(float(duration or 0)), "address": address or None, "outgoing": bool(originated),
                      "answered": bool(answered), "name": name or None})
    return found


def missed_not_returned(calls: list[dict]) -> list[dict]:
    """Incoming calls not answered with no later call with that number (returned, or they called back and
    it was answered). Newest first, one per number."""
    later: dict[str, str] = {}
    found, seen = [], set()
    for call in sorted(calls, key=lambda c: c["at"], reverse=True):
        key = key_of(call["address"])
        if key is None:  # a hidden number cannot be returned: each one is its own reminder
            if not (call["outgoing"] or call["answered"]):
                found.append(call)
            continue
        settled = call["outgoing"] or call["answered"]
        if not settled and key not in later and key not in seen:
            found.append(call)
            seen.add(key)
        if settled:
            later.setdefault(key, call["at"])
    return found


class ContactsBook:
    """Names from macOS Contacts (which also holds the iCloud, Google and Microsoft accounts added to the system), by
    number or address, and the people themselves to pick from; read once every ten minutes."""

    def __init__(self):
        import Contacts

        self.kit = Contacts
        self.cache: tuple[float, dict[str, str], list[dict]] | None = None
        self.lock = threading.Lock()

    def status(self) -> str:
        value = self.kit.CNContactStore.authorizationStatusForEntityType_(self.kit.CNEntityTypeContacts)
        return {0: "undetermined", 1: "restricted", 2: "denied", 3: "granted", 4: "granted"}.get(value, "undetermined")

    def request(self) -> str:
        done = threading.Event()
        self.kit.CNContactStore.alloc().init().requestAccessForEntityType_completionHandler_(self.kit.CNEntityTypeContacts, lambda ok, error: done.set())
        done.wait(25)
        self.cache = None
        return self.status()

    def names(self) -> dict[str, str]:
        return self._read()[0]

    def people(self) -> list[dict]:
        """Everyone in Contacts with a name: {name, org, emails}."""
        return self._read()[1]

    def _read(self) -> tuple[dict[str, str], list[dict]]:
        if self.status() != "granted":
            return {}, []
        with self.lock:
            if self.cache and time.monotonic() - self.cache[0] < CONTACTS_TTL:
                return self.cache[1], self.cache[2]
            kit, found, people = self.kit, {}, []
            keys = [kit.CNContactGivenNameKey, kit.CNContactFamilyNameKey, kit.CNContactOrganizationNameKey,
                    kit.CNContactPhoneNumbersKey, kit.CNContactEmailAddressesKey]
            request = kit.CNContactFetchRequest.alloc().initWithKeysToFetch_(keys)

            def each(contact, stop):
                name = " ".join(p for p in (str(contact.givenName() or ""), str(contact.familyName() or "")) if p) or str(contact.organizationName() or "")
                if not name:
                    return
                emails = [str(item.value()) for item in list(contact.emailAddresses() or [])]
                people.append({"name": name, "org": str(contact.organizationName() or "") or None, "emails": [e for e in emails if "@" in e][:5]})
                for item in list(contact.phoneNumbers() or []) + list(contact.emailAddresses() or []):
                    value = item.value()
                    key = key_of(str(value.stringValue()) if hasattr(value, "stringValue") else str(value))
                    if key:
                        found.setdefault(key, name)
            kit.CNContactStore.alloc().init().enumerateContactsWithFetchRequest_error_usingBlock_(request, None, each)
            self.cache = (time.monotonic(), found, people)
            return found, people


class FakeContacts:
    def __init__(self, names=None, status="granted", people=None):
        self.book, self.state, self.everyone = names or {}, status, people or []

    def people(self) -> list[dict]:
        return list(self.everyone) if self.state == "granted" else []

    def status(self) -> str:
        return self.state

    def request(self) -> str:
        return self.state

    def names(self) -> dict[str, str]:
        return dict(self.book) if self.state == "granted" else {}


def default_contacts():
    try:
        return ContactsBook()
    except Exception:  # noqa: BLE001 - not macOS: no names
        return FakeContacts(status="unavailable")


def find_people(book, query: str, limit: int = 8) -> list[dict]:
    """Contacts whose name, company or address matches what is typed; a word that starts with it goes first."""
    words = query.casefold().split()
    if not words:
        return []
    found = []
    for person in book.people():
        text = " ".join([person["name"], person.get("org") or "", *person.get("emails", [])]).casefold()
        if all(w in text for w in words):
            starts = sum(1 for w in words if any(part.startswith(w) for part in text.replace("@", " ").split()))
            found.append((-starts, person["name"].casefold(), person))
    found.sort(key=lambda item: item[:2])
    return [{"name": p["name"], "org": p.get("org"), "email": (p.get("emails") or [None])[0]} for _, _, p in found[:limit]]


_CONTACTS = None
_CONTACTS_LOCK = threading.Lock()


def shared_contacts():
    global _CONTACTS
    with _CONTACTS_LOCK:
        if _CONTACTS is None:
            _CONTACTS = default_contacts()
        return _CONTACTS


def use_contacts(book) -> None:
    global _CONTACTS
    with _CONTACTS_LOCK:
        _CONTACTS = book
