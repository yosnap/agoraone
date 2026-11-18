"""What the «Central» section shows, read live from Central's API v1 and cut down to the fields each view needs.

Every view is a fixed path of the API chosen from a closed list (the screen never names a path), each item id has
the shape of a cuid, and each view accepts only its own query parameters, checked here. Whatever Central answers
is copied field by field: disk paths, IPs, SSH addresses, tokens and Central's own links never reach the screen,
and free text is scrubbed again of IPs and user paths (Central already does it; this is the second lock).
Contact (address, phone, tax id) appears only in a client's record, never in a list. Servers come without their SSH
address, panel URL, key paths nor the IPs of who logged in or attacked them, even if Central ever sent them."""

import math
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from . import central, central_api

VIEW_SECONDS = 20  # a whole view, however many requests it takes: the screen waits for it
ID = re.compile(r"[a-z0-9]{20,32}")
LIST_PATHS = {"alertas": "/api/v1/alertas", "pendientes": "/api/v1/pendientes", "clientes": "/api/v1/clientes", "proyectos": "/api/v1/proyectos",
              "webs": "/api/v1/webs", "servidores": "/api/v1/servidores", "agenda": "/api/v1/agenda"}
ITEM_PATHS = {"clientes": "/api/v1/clientes/{id}", "proyectos": "/api/v1/proyectos/{id}", "servidores": "/api/v1/servidores/{id}"}
VIEWS = ("resumen", *LIST_PATHS)
PROJECT_STATUSES = ("ACTIVE", "MAINTENANCE", "DORMANT", "ARCHIVED")
PROJECT_KINDS = ("CLIENT", "OWN", "TRAINING", "EXPERIMENT")
WEB_KINDS = ("CLIENT", "OWN", "CENTRAL")
LEVELS = ("green", "amber", "red", "grey")
AGENDA_DAYS = 62  # Central's own limit, measured as it does: from 00:00 of «desde» to the end of «hasta», in Madrid
MADRID = ZoneInfo("Europe/Madrid")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
_HOST = re.compile(r"(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+")
SUMMARY_PAGES = 5  # active projects counted up to 1000; more is shown as «1000+»
_OCTET = r"(?:25[0-5]|2[0-4]\d|1?\d?\d)"
_IPV4_RE = rf"{_OCTET}(?:\.{_OCTET}){{3}}"
_IPV4_DASHED = rf"{_OCTET}(?:-{_OCTET}){{3}}(?=\.)"  # the dashed form of sslip.io, Dokploy or traefik.me: 1-2-3-4.host
_IPV6 = r"(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{0,4}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)"
# An IP in free text, also inside a host name (web.1.2.3.4.sslip.io, app-1-2-3-4.traefik.me), as Central's own
# `IP_IN_TEXT` (src/lib/api/scrub.ts), but not inside a longer series of numbers (1.2.3.4.5).
_IPV4 = re.compile(rf"(?<!\d\.)(?<!\d)(?:{_IPV4_RE}(?!\.?\d)(?::\d{{1,5}})?|{_IPV4_DASHED}|(?<![\w:]){_IPV6}(?![\w.:]))", re.I)
# A host name that carries an IPv4 among its labels, with dots or dashes.
_HOST_IP = re.compile(r"(?:^|[.-])(?:\d{1,3}[.-]){3}\d{1,3}(?:[.-]|$)")
# Names that only resolve inside a network, or aliases of an IP: never shown as a public address.
_NOT_PUBLIC = re.compile(r"(?:^|\.)(?:local|internal|lan|home|localhost|home\.arpa|sslip\.io|nip\.io|xip\.io)$")
# Never inside a URL or a word (https://ex.com/opt/app stays as it is): only a path that starts a token.
# Only what Central itself hides (`SENSITIVE_PATH`): user folders, SSH folders and key files. For a server's
# texts, where /etc, /var or /opt are the system's own paths and the fix commands must stay whole.
_SECRET_PATH = re.compile(r"(?:~|/Users|/home|/root)/[^\s,;)\"']*|[^\s,;)\"']*\.ssh/[^\s,;)\"']*|\bid_(?:rsa|ed25519|ecdsa|dsa)\b[^\s,;)\"']*"
                          r"|[^\s,;)\"']+\.(?:pem|key)\b|[A-Za-z]:\\Users\\\S*")
_PATH = re.compile(r"(?<![\w.-])(?:~/|/Users/|/home/|/root/|/Volumes/|/private/|/var/|/etc/|/opt/|[A-Za-z]:\\)\S*|\S*\.ssh/\S*|\bid_(?:rsa|ecdsa|ed25519)\S*|\S+\.pem\b")


_TLD = re.compile(r"[a-z]{2,63}|xn--[a-z0-9-]{1,59}")


class ViewError(ValueError):
    """A request the screen should not make: unknown parameter or a value out of its list (answered with 422)."""


def _text(value, limit: int = 2000, paths: re.Pattern = _PATH) -> str | None:
    if not isinstance(value, str):
        return None
    clean = paths.sub("[ruta oculta]", _IPV4.sub("[IP oculta]", value))
    return clean[:limit]


def _plain(value, limit: int = 200) -> str | None:
    """A short value shown as is (a name, a state, a version): text only, cut to size."""
    return value[:limit] if isinstance(value, str) else None


def _number(value) -> int | float | None:
    """A number shown as is; never a bool, NaN nor an infinity (the screen's JSON cannot carry them)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def _id(value) -> str | None:
    return value if isinstance(value, str) and ID.fullmatch(value) else None


REVISION = re.compile(r"[0-9a-f]{20}")


def revision(value) -> str | None:
    """The `version` Central gives a record to change it (a hash of its editable fields), or None: then that record
    cannot be changed from AgoraOne (a Central without the write API)."""
    return value if isinstance(value, str) and REVISION.fullmatch(value) else None


def _web_url(value) -> str | None:
    """A public web address: https or http with a host name, never an IP literal, a name carrying one (sslip.io,
    traefik.me, Dokploy's 1-2-3-4 form, any domain) nor a name of a local network (.local, .internal, .lan…)."""
    if not isinstance(value, str) or len(value) > 500:
        return None
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower()
    except ValueError:
        return None
    if parts.scheme not in ("https", "http") or not host or parts.username or parts.password or ":" in host:
        return None
    # A name with a real top-level domain: never a number in any base (203.0.113.7, 0x7f000001, 017700000001) nor a bare host.
    if "." not in host or not _TLD.fullmatch(host.rsplit(".", 1)[1]) or _NOT_PUBLIC.search(host) or _HOST_IP.search(host):
        return None
    return value


def _rows(data: dict, name: str) -> list[dict]:
    value = data.get(name)
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _list(values, limit: int = 50) -> list[str]:
    return [_plain(v) for v in values[:limit] if isinstance(v, str)] if isinstance(values, list) else []


# ---- Query parameters ------------------------------------------------------------------------------------------

def _free(name: str, value: str) -> str:
    value = value.strip()
    if not 1 <= len(value) <= 200 or not value.isprintable():
        raise ViewError(f"El parámetro «{name}» no es válido.")
    return value


def _choice(options):
    def check(name: str, value: str) -> str:
        if value not in options:
            raise ViewError(f"El parámetro «{name}» no es válido.")
        return value
    return check


def _cursor(name: str, value: str) -> str:
    if not ID.fullmatch(value):
        raise ViewError("El cursor no es válido.")
    return value


def _limit(name: str, value: str) -> int:
    if not (value.isascii() and value.isdigit()) or not 1 <= int(value) <= 200:
        raise ViewError("El límite va de 1 a 200.")
    return int(value)


def _day(name: str, value: str) -> str:
    """A day AAAA-MM-DD that exists (2026-02-31 does not)."""
    try:
        if not (value.isascii() and _DAY.fullmatch(value)):
            raise ValueError
        if not 2000 <= date.fromisoformat(value).year <= 2100:  # Central reads years before 100 as 19xx; 9999 overflows
            raise ValueError
    except ValueError:
        raise ViewError(f"«{name}» tiene que ser un día AAAA-MM-DD que exista.") from None
    return value


def _agenda_range(query: dict) -> None:
    """Both days, in order and at most 62 days apart counted like Central (a day of the autumn change has 25 hours)."""
    if set(query) != {"desde", "hasta"}:
        raise ViewError("La agenda necesita «desde» y «hasta».")
    start = datetime.combine(date.fromisoformat(query["desde"]), datetime.min.time(), MADRID)
    end = datetime.combine(date.fromisoformat(query["hasta"]) + timedelta(days=1), datetime.min.time(), MADRID)
    if end <= start:
        raise ViewError("«hasta» es anterior a «desde».")
    # In real time (timestamps): two datetimes of the same zone subtract by the clock and would miss the extra hour.
    if end.timestamp() - start.timestamp() - 0.001 > AGENDA_DAYS * 86400:
        raise ViewError(f"La agenda abarca como mucho {AGENDA_DAYS} días.")


PARAMS = {"proyectos": {"estado": _choice(PROJECT_STATUSES), "tipo": _choice(PROJECT_KINDS), "cliente": _free, "q": _free,
                        "cursor": _cursor, "limite": _limit},
          "webs": {"tipo": _choice(WEB_KINDS), "caidas": _choice(("1",))},
          "agenda": {"desde": _day, "hasta": _day}}
CHECKS = {"agenda": _agenda_range}  # what a view checks of its parameters together


def params_of(view: str, given: dict[str, str]) -> dict:
    allowed = PARAMS.get(view, {})
    unknown = sorted(set(given) - set(allowed))
    if unknown:
        raise ViewError(f"Parámetro no permitido: «{unknown[0][:40]}».")
    query = {name: allowed[name](name, value) for name, value in given.items()}
    if view in CHECKS:
        CHECKS[view](query)
    return query


# ---- Shapes ----------------------------------------------------------------------------------------------------

def alert(row: dict) -> dict:
    """Without `href`: a path of Central's web, which only its own window (later) may open."""
    return {"key": _plain(row.get("key")), "kind": _plain(row.get("kind"), 20), "level": "critical" if row.get("level") == "critical" else "warning",
            "title": _text(row.get("title"), 300), "detail": _text(row.get("detail"), 600), "at": _plain(row.get("at"), 40)}


def pending(row: dict) -> dict:
    return {"id": _id(row.get("id")), "name": _plain(row.get("name")), "client": _plain(row.get("client")),
            "missing": [_text(m, 200) for m in (row.get("missing") or [])[:30] if isinstance(m, str)]}


def client_row(row: dict) -> dict:
    return {"id": _id(row.get("id")), "name": _plain(row.get("name")), "company": _plain(row.get("company")),
            "projects": _number(row.get("projects")), "websites": _number(row.get("websites"))}


def website(row: dict) -> dict:
    return {"id": _id(row.get("id")), "url": _web_url(row.get("url")), "label": _plain(row.get("label")), "kind": _plain(row.get("kind"), 20),
            "status": _plain(row.get("lastStatus"), 20), "code": _number(row.get("lastCode")), "ms": _number(row.get("lastMs")),
            "checkedAt": _plain(row.get("lastCheckedAt"), 40), "sslDaysLeft": _number(row.get("sslDaysLeft"))}


def note(row: dict) -> dict:
    return {"id": _id(row.get("id")), "body": _text(row.get("body"), 4000), "pinned": row.get("pinned") is True, "createdAt": _plain(row.get("createdAt"), 40)}


def client_record(data: dict) -> dict:
    """A client's record: contact (shown only here, hidden in discreet mode by the screen), projects, websites, notes."""
    projects = [{"id": _id(p.get("id")), "name": _plain(p.get("name")), "kind": _plain(p.get("kind"), 20), "status": _plain(p.get("status"), 20),
                 "phase": _plain(p.get("phase")), "version": _plain(p.get("version"), 40), "repo": central.github_repo(p.get("repoUrl")),
                 "lastActivity": _plain(p.get("lastActivityAt"), 40)} for p in _rows(data, "projects")]
    return {"id": _id(data.get("id")), "name": _plain(data.get("name")), "company": _plain(data.get("company")),
            "email": _plain(data.get("email")), "phone": _plain(data.get("phone"), 60), "taxId": _plain(data.get("taxId"), 40),
            "address": _text(data.get("address"), 300), "projects": projects, "websites": [website(w) for w in _rows(data, "websites")],
            "notes": [note(n) for n in _rows(data, "notes")], "revision": revision(data.get("version"))}


def project_row(row: dict) -> dict:
    return {"id": _id(row.get("id")), "name": _plain(row.get("name")), "type": _plain(row.get("type"), 40), "kind": _plain(row.get("kind"), 20),
            "status": _plain(row.get("status"), 20), "phase": _plain(row.get("phase")), "client": _plain(row.get("client")),
            "version": _plain(row.get("version"), 40), "framework": _plain(row.get("framework"), 80), "lastActivity": _plain(row.get("lastActivity"), 40)}


def project_record(data: dict) -> dict:
    """A project's record: deployment, services and health (its websites). Never its folders, local URL, compose
    services, variable files, push token or anything else that describes this or another machine."""
    client = data.get("client") if isinstance(data.get("client"), dict) else {}
    # Central's record gives in `version` the hash to change it, over the project's own version: never shown as that.
    edit = revision(data.get("version"))
    services = [{"id": _id(s.get("id")), "name": _plain(s.get("name"), 80), "environment": _plain(s.get("environment"), 40),
                 "url": _web_url(s.get("url")), "hosting": _text(s.get("hosting"), 120), "liveVersion": _plain(s.get("liveVersion"), 40),
                 "liveVersionAt": _plain(s.get("liveVersionAt"), 40)} for s in _rows(data, "services")]
    return {"id": _id(data.get("id")), "name": _plain(data.get("name")), "kind": _plain(data.get("kind"), 20), "status": _plain(data.get("status"), 20),
            "phase": _plain(data.get("phase")), "description": _text(data.get("description"), 2000), "client": {"id": _id(client.get("id")), "name": _plain(client.get("name"))} if client else None,
            "version": None if edit else _plain(data.get("version"), 40), "framework": _plain(data.get("framework"), 80), "stack": _list(data.get("stack")),
            "statusLocked": data.get("statusLocked") is True, "revision": edit, "repo": central.github_repo(data.get("repoUrl")), "defaultBranch": _plain(data.get("defaultBranch"), 100),
            "lastCommitAt": _plain(data.get("lastCommitAt"), 40), "lastActivity": _plain(data.get("lastActivityAt"), 40),
            "deploy": {"status": _plain(data.get("deployStatus"), 20), "hosting": _text(data.get("hosting"), 120),
                       "version": _plain(data.get("deployedVersion"), 40), "environments": _list(data.get("environments"), 10)},
            "services": services, "websites": [website(w) for w in _rows(data, "websites")], "notes": [note(n) for n in _rows(data, "notes")],
            "auditedAt": _plain(data.get("auditedAt"), 40)}


def website_row(row: dict) -> dict:
    """A monitored website of the «Webs» list (Central's `listWebsites`: its last check, not the 7-day figures)."""
    return {"id": _id(row.get("id")), "url": _web_url(row.get("url")), "kind": _plain(row.get("kind"), 20), "client": _plain(row.get("client")),
            "status": _plain(row.get("status"), 20), "code": _number(row.get("code")), "ms": _number(row.get("ms")), "checkedAt": _plain(row.get("checkedAt"), 40)}


def _level(value) -> str:
    return value if value in LEVELS else "grey"


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _ints(values, limit: int = 100) -> list[int]:
    return [v for v in values[:limit] if isinstance(v, int) and not isinstance(v, bool)] if isinstance(values, list) else []


def _domain(value) -> str | None:
    """A public host name the server's proxy serves; never an IP nor an alias of one."""
    if not isinstance(value, str) or len(value) > 253 or not _HOST.fullmatch(value.lower()):
        return None
    host = value.lower()
    return host if _web_url(f"https://{host.removeprefix('*.')}") else None


# The health cards of a server, field by field. Not the origins of the sessions inside (IPs) nor anything else.
_CARD_FIELDS = {"cpu": ("pct",), "memory": ("pct",), "disk": ("pct",), "webs": ("down", "slow"), "certificate": ("days",), "sessions": ("count",),
                "attempts": ("hour", "day"), "banned": ("now",), "maintenance": ("pending", "security", "reboot")}


def _cards(value) -> dict:
    cards = {}
    for name, fields in _CARD_FIELDS.items():
        card = _dict(_dict(value).get(name))
        if card:
            cards[name] = {"level": _level(card.get("level")),
                           **{f: (card.get(f) is True) if f == "reboot" else _number(card.get(f)) for f in fields}}
    ports = _dict(_dict(value).get("ports"))
    if ports:
        cards["ports"] = {"level": _level(ports.get("level")), "odd": _ints(ports.get("odd")), "exposed": _ints(ports.get("exposed"))}
    services = _dict(_dict(value).get("services"))
    if services:
        cards["services"] = {"level": _level(services.get("level")), "ok": _number(services.get("ok")), "total": _number(services.get("total")),
                             "down": _list(services.get("down"), 100), "stopped": _list(services.get("stopped"), 100)}
    return cards


def server_row(row: dict) -> dict:
    """A server as Central shows it to its apps: state, load, protection and what it hosts. Never its SSH address,
    port, panel URL nor key path (Central already removes them; this copy does not even look at them)."""
    services = _dict(row.get("services"))
    protection = _dict(row.get("protection"))
    projects = [{"projectId": _id(p.get("projectId")), "project": _plain(p.get("project")), "service": _plain(p.get("service"), 80),
                 "environment": _plain(p.get("environment"), 40), "url": _web_url(p.get("url")),
                 "containers": [{"name": _plain(c.get("name"), 120), "state": _plain(c.get("state"), 20)} for c in _rows(p, "containers")[:50]]}
                for p in _rows(row, "projects")[:200]]
    return {"id": _id(row.get("id")), "name": _plain(row.get("name")), "provider": _plain(row.get("provider"), 60), "panel": _plain(row.get("panel"), 40),
            "status": _level(row.get("status")), "error": _text(row.get("error"), 500, _SECRET_PATH), "lastOkAt": _plain(row.get("lastOkAt"), 40),
            "cpu": _number(row.get("cpu")), "memory": _number(row.get("memory")), "disk": _number(row.get("disk")),
            "services": {"ok": _number(services.get("ok")), "total": _number(services.get("total")), "down": _list(services.get("down"), 100)} if services else None,
            "protection": {"done": _number(protection.get("done")), "total": _number(protection.get("total")), "level": _level(protection.get("level"))} if protection else None,
            "projects": projects}


def server_record(data: dict) -> dict:
    """A server's record: its row plus the health cards, the protection checks, the containers and the domains."""
    containers = [{"name": _plain(c.get("name"), 120), "kind": _plain(c.get("kind"), 20), "state": _plain(c.get("state"), 20), "detail": _text(c.get("detail"), 300, _SECRET_PATH)}
                  for c in _rows(data, "containers")[:300]]
    checks = [{"key": _plain(c.get("key"), 80), "ok": c.get("ok") if isinstance(c.get("ok"), bool) else None, "detail": _text(c.get("detail"), 500, _SECRET_PATH),
               "fix": _text(c.get("fix"), 1000, _SECRET_PATH)} for c in _rows(data, "checks")[:100]]
    domains = [d for d in (_domain(v) for v in (data.get("domains") or [])[:300]) if d] if isinstance(data.get("domains"), list) else None
    return {**server_row(data), "cards": _cards(data.get("cards")), "readAt": _plain(data.get("readAt"), 40), "root": data.get("root") is True,
            "domains": domains, "containers": containers, "checks": checks}


def agenda_event(row: dict) -> dict:
    """An event of Central's agenda with the client or project it is linked to. Without its Google Calendar link."""
    return {"summary": _text(row.get("summary"), 300), "calendar": _plain(row.get("calendar"), 120), "start": _plain(row.get("start"), 40),
            "end": _plain(row.get("end"), 40), "allDay": row.get("allDay") is True, "location": _text(row.get("location"), 300),
            "client": _plain(row.get("client")), "project": _plain(row.get("project"))}


# ---- Reading ---------------------------------------------------------------------------------------------------

def read_list(target: central_api.Connection, view: str, query: dict) -> dict:
    with central_api.session(VIEW_SECONDS) as (client, deadline):
        def get(path: str, params: dict | None = None) -> dict:
            return central_api.request(target, "GET", path, params, client=client, deadline=deadline)
        if view == "resumen":
            return _summary(get)
        data = get(LIST_PATHS[view], query or None)
    if view == "alertas":
        return {"alerts": [alert(a) for a in _rows(data, "alerts")]}
    if view == "pendientes":
        return {"pending": [pending(p) for p in _rows(data, "pending")]}
    if view == "clientes":
        return {"clients": [client_row(c) for c in _rows(data, "clients")]}
    if view == "webs":
        return {"websites": [website_row(w) for w in _rows(data, "websites")]}
    if view == "servidores":
        return {"servers": [server_row(s) for s in _rows(data, "servers")]}
    if view == "agenda":
        errors = data.get("errors")
        return {"events": [agenda_event(e) for e in _rows(data, "events")],
                "errors": [_text(e, 300) for e in errors[:20] if isinstance(e, str)] if isinstance(errors, list) else []}
    rows = [project_row(p) for p in _rows(data, "projects")]
    if query.get("cliente"):
        # Central matches «cliente» as «contains»: only that client's own projects are shown (a page may come shorter).
        wanted = query["cliente"].casefold()
        rows = [p for p in rows if (p["client"] or "").casefold() == wanted]
    return {"projects": rows, "nextCursor": _id(data.get("nextCursor"))}


def _summary(get) -> dict:
    """The first four requests at once (one connection, safe across threads); further project pages, if any, after."""
    first = {"estado": "ACTIVE", "limite": 200}
    with ThreadPoolExecutor(max_workers=4) as pool:
        asked = [pool.submit(get, LIST_PATHS[name]) for name in ("alertas", "pendientes", "clientes")]
        asked.append(pool.submit(get, LIST_PATHS["proyectos"], first))
        answers = [future.result() for future in asked]
    alerts, waiting, clients = _rows(answers[0], "alerts"), _rows(answers[1], "pending"), _rows(answers[2], "clients")
    active, cursor, more = 0, None, False
    for page in range(SUMMARY_PAGES):
        data = answers[3] if page == 0 else get(LIST_PATHS["proyectos"], {**first, "cursor": cursor})
        active += len(_rows(data, "projects"))
        cursor = _id(data.get("nextCursor"))
        if not cursor:
            break
        more = page == SUMMARY_PAGES - 1
    critical = sum(1 for a in alerts if a.get("level") == "critical")
    return {"alerts": {"critical": critical, "warning": len(alerts) - critical}, "pending": len(waiting), "clients": len(clients),
            "activeProjects": active, "activeProjectsMore": more}


def read_item(target: central_api.Connection, view: str, item: str) -> dict:
    with central_api.session(VIEW_SECONDS) as (client, deadline):
        data = central_api.request(target, "GET", ITEM_PATHS[view].format(id=item), client=client, deadline=deadline)
    return {"clientes": client_record, "proyectos": project_record, "servidores": server_record}[view](data)


# ---- The snapshot as a fallback for clients --------------------------------------------------------------------

def stored_clients(snapshot: dict | None) -> dict | None:
    """The clients of the last snapshot, in the list's shape, when Central does not answer now."""
    if not snapshot or not isinstance(snapshot.get("clients"), list):
        return None
    rows = [{"id": _id(c.get("id")), "name": _plain(c.get("name")), "company": _plain(c.get("company")),
             "projects": len(c.get("projects") or []), "websites": len(c.get("websites") or [])} for c in snapshot["clients"] if isinstance(c, dict)]
    return {"clients": rows}


def stored_client(snapshot: dict | None, item: str) -> dict | None:
    """One client of the last snapshot as a record (no notes nor ids of its projects: the snapshot has none)."""
    for c in (snapshot or {}).get("clients") or []:
        if isinstance(c, dict) and c.get("id") == item:
            return {"id": item, "name": _plain(c.get("name")), "company": _plain(c.get("company")), "email": _plain(c.get("email")),
                    "phone": _plain(c.get("phone"), 60), "taxId": _plain(c.get("taxId"), 40), "address": None,
                    "projects": [{"id": None, "name": _plain(p.get("name")), "kind": None, "status": _plain(p.get("status"), 20), "phase": _plain(p.get("phase")),
                                  "version": None, "repo": _plain(p.get("repo")), "lastActivity": None} for p in c.get("projects") or [] if isinstance(p, dict)],
                    "websites": [{"id": None, "url": _web_url(w.get("url")), "label": None, "kind": None, "status": _plain(w.get("status"), 20), "code": None,
                                  "ms": None, "checkedAt": None, "sslDaysLeft": None} for w in c.get("websites") or [] if isinstance(w, dict)],
                    "notes": [], "revision": None}
    return None
