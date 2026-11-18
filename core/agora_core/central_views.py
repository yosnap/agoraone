"""What the «Central» section shows, read live from Central's API v1 and cut down to the fields each view needs.

Every view is a fixed path of the API chosen from a closed list (the screen never names a path), each item id has
the shape of a cuid, and each view accepts only its own query parameters, checked here. Whatever Central answers
is copied field by field: disk paths, IPs, SSH addresses, tokens and Central's own links never reach the screen,
and free text is scrubbed again of IPs and user paths (Central already does it; this is the second lock).
Contact (address, phone, tax id) appears only in a client's record, never in a list."""

import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

from . import central, central_api

VIEW_SECONDS = 20  # a whole view, however many requests it takes: the screen waits for it
ID = re.compile(r"[a-z0-9]{20,32}")
LIST_PATHS = {"alertas": "/api/v1/alertas", "pendientes": "/api/v1/pendientes", "clientes": "/api/v1/clientes", "proyectos": "/api/v1/proyectos"}
ITEM_PATHS = {"clientes": "/api/v1/clientes/{id}", "proyectos": "/api/v1/proyectos/{id}"}
VIEWS = ("resumen", *LIST_PATHS)
PROJECT_STATUSES = ("ACTIVE", "MAINTENANCE", "DORMANT", "ARCHIVED")
PROJECT_KINDS = ("CLIENT", "OWN", "TRAINING", "EXPERIMENT")
SUMMARY_PAGES = 5  # active projects counted up to 1000; more is shown as «1000+»
_IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w.])")
# Never inside a URL or a word (https://ex.com/opt/app stays as it is): only a path that starts a token.
_PATH = re.compile(r"(?<![\w.-])(?:~/|/Users/|/home/|/root/|/Volumes/|/private/|/var/|/etc/|/opt/|[A-Za-z]:\\)\S*|\S*\.ssh/\S*|\bid_(?:rsa|ecdsa|ed25519)\S*|\S+\.pem\b")


_TLD = re.compile(r"[a-z]{2,63}|xn--[a-z0-9-]{1,59}")


class ViewError(ValueError):
    """A request the screen should not make: unknown parameter or a value out of its list (answered with 422)."""


def _text(value, limit: int = 2000) -> str | None:
    if not isinstance(value, str):
        return None
    clean = _PATH.sub("[ruta oculta]", _IPV4.sub("[IP oculta]", value))
    return clean[:limit]


def _plain(value, limit: int = 200) -> str | None:
    """A short value shown as is (a name, a state, a version): text only, cut to size."""
    return value[:limit] if isinstance(value, str) else None


def _number(value) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _id(value) -> str | None:
    return value if isinstance(value, str) and ID.fullmatch(value) else None


def _web_url(value) -> str | None:
    """A public web address: https or http with a host name, never an IP literal nor a «sslip.io»-like alias of one."""
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
    if "." not in host or not _TLD.fullmatch(host.rsplit(".", 1)[1]) or re.search(r"(?:^|\.)(?:sslip|nip|xip)\.io$", host):
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


PARAMS = {"proyectos": {"estado": _choice(PROJECT_STATUSES), "tipo": _choice(PROJECT_KINDS), "cliente": _free, "q": _free,
                        "cursor": _cursor, "limite": _limit}}


def params_of(view: str, given: dict[str, str]) -> dict:
    allowed = PARAMS.get(view, {})
    unknown = sorted(set(given) - set(allowed))
    if unknown:
        raise ViewError(f"Parámetro no permitido: «{unknown[0][:40]}».")
    return {name: allowed[name](name, value) for name, value in given.items()}


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
            "notes": [note(n) for n in _rows(data, "notes")]}


def project_row(row: dict) -> dict:
    return {"id": _id(row.get("id")), "name": _plain(row.get("name")), "type": _plain(row.get("type"), 40), "kind": _plain(row.get("kind"), 20),
            "status": _plain(row.get("status"), 20), "phase": _plain(row.get("phase")), "client": _plain(row.get("client")),
            "version": _plain(row.get("version"), 40), "framework": _plain(row.get("framework"), 80), "lastActivity": _plain(row.get("lastActivity"), 40)}


def project_record(data: dict) -> dict:
    """A project's record: deployment, services and health (its websites). Never its folders, local URL, compose
    services, variable files, push token or anything else that describes this or another machine."""
    client = data.get("client") if isinstance(data.get("client"), dict) else {}
    services = [{"id": _id(s.get("id")), "name": _plain(s.get("name"), 80), "environment": _plain(s.get("environment"), 40),
                 "url": _web_url(s.get("url")), "hosting": _text(s.get("hosting"), 120), "liveVersion": _plain(s.get("liveVersion"), 40),
                 "liveVersionAt": _plain(s.get("liveVersionAt"), 40)} for s in _rows(data, "services")]
    return {"id": _id(data.get("id")), "name": _plain(data.get("name")), "kind": _plain(data.get("kind"), 20), "status": _plain(data.get("status"), 20),
            "phase": _plain(data.get("phase")), "description": _text(data.get("description"), 2000), "client": {"id": _id(client.get("id")), "name": _plain(client.get("name"))} if client else None,
            "version": _plain(data.get("version"), 40), "framework": _plain(data.get("framework"), 80), "stack": _list(data.get("stack")),
            "repo": central.github_repo(data.get("repoUrl")), "defaultBranch": _plain(data.get("defaultBranch"), 100),
            "lastCommitAt": _plain(data.get("lastCommitAt"), 40), "lastActivity": _plain(data.get("lastActivityAt"), 40),
            "deploy": {"status": _plain(data.get("deployStatus"), 20), "hosting": _text(data.get("hosting"), 120),
                       "version": _plain(data.get("deployedVersion"), 40), "environments": _list(data.get("environments"), 10)},
            "services": services, "websites": [website(w) for w in _rows(data, "websites")], "notes": [note(n) for n in _rows(data, "notes")],
            "auditedAt": _plain(data.get("auditedAt"), 40)}


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
    return client_record(data) if view == "clientes" else project_record(data)


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
                    "notes": []}
    return None
