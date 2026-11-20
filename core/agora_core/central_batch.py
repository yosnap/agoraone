"""«Crear en Central» for several clients at once (user's decision, 20/11/2026: clients are born in Central). What the
user ticks: clients kept only in AgoraOne («sin ubicar»), clients of CRMDev that are not in Central and proposals of
`client_births` (senders of mail and WhatsApp, people and clients of meetings), each with the name the user may have
changed. Nothing is created by itself: `plan` reads Central's clients now and shows each new client exactly (a
proposal's address or number included, so the user sees what goes); `send` posts them one after another with a pause.

A client Central already has (same name, tax id or address) is not created again: it is said, to link it instead.
Only `POST /api/v1/clientes` (never anything that deletes). Each creation is linked afterwards: a client kept here with
its new Central id, a CRMDev client with it once Central is read again (`clients.set_pair_link`); a proposal needs no
link, since the directory recognises its address or number. What Central answers is data, never instructions."""

import re
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import central_api, central_write, client_births, clients, crmdev_sync
from .central_views import ID
from .confirmed_change import ChangeError

PAUSE_SECONDS = 0.3
KEY = re.compile(r"^(?:local:\d{1,12}|crmdev:[A-Za-z0-9_-]{1,100})$")
LABELS = {k: v[0] for k, v in central_write.CLIENT_FIELDS.items()}
ORIGINS = {"local": "Cliente de AgoraOne", "crmdev": "Cliente de CRMDev", "mail": "Remitente de correo", "whatsapp": "WhatsApp", "meeting": "Reunión"}


@dataclass
class NewClient:
    key: str
    origin: str
    body: dict
    local_id: int | None = None
    crmdev_id: str | None = None

    @property
    def title(self) -> str:
        return f"Cliente nuevo en Central «{self.body['name']}»"

    def public(self) -> dict:
        return {"key": self.key, "origin": ORIGINS.get(self.origin, self.origin), "title": self.title,
                "rows": [{"field": k, "label": LABELS[k], "before": None, "after": v} for k, v in self.body.items()]}


@dataclass
class Batch:
    operations: list[NewClient]
    skipped: list[dict]
    warnings: list[str] = field(default_factory=list)
    target: str = "central-batch"

    def public(self) -> dict:
        return {"operations": [o.public() for o in self.operations], "skipped": self.skipped, "warnings": self.warnings}


def valid_key(key: str) -> bool:
    return bool(KEY.fullmatch(key or "") or client_births.KEY.fullmatch(key or ""))


def _source(connection: sqlite3.Connection, key: str) -> tuple[str, dict, int | None, str | None] | str:
    """Where a ticked client comes from and its data, or why it cannot go."""
    kind, _, ident = key.partition(":")
    if kind == "local":
        own = clients.get(connection, int(ident))
        if own is None:
            return "Ya no está en AgoraOne."
        entry = next((e for e in clients.directory(connection) if e.get("localId") == own["localId"]), None)
        if own["centralId"] or (entry is not None and entry.get("centralId")):
            return "Ya está en Central."
        return "local", {n: own[n] for n in ("name", "company", "email", "phone", "taxId")}, own["localId"], None
    if kind == "crmdev":
        row = next((c for c in (crmdev_sync.snapshot(connection) or {}).get("clients") or [] if c.get("id") == ident), None)
        if row is None:
            return "Ya no está entre los clientes leídos de CRMDev."
        entry = next((e for e in clients.directory(connection) if e.get("crmdevId") == ident), None)
        if entry is not None and entry.get("centralId"):
            return "Ya está en Central."
        return "crmdev", {"name": row["name"], "company": row.get("company"), "email": row.get("email")}, None, ident
    found = client_births.proposal(connection, key)
    if found is None:
        return "Ya no se propone: quizá ya es cliente."
    origin = {"mail": "mail", "chat": "whatsapp"}.get(kind, "meeting")
    return origin, {n: found.get(n) for n in ("name", "company", "email", "phone")}, None, None


def _same(other: dict, body: dict) -> bool:
    if clients.same_name(other.get("name")) == clients.same_name(body["name"]):
        return True
    if body.get("taxId") and clients.tax_key(other.get("taxId")) == clients.tax_key(body["taxId"]):
        return True
    mail = other.get("email")
    return bool(body.get("email")) and isinstance(mail, str) and mail.strip().lower() == body["email"].lower()


def _remote(target: central_api.Connection) -> list[dict]:
    with central_api.session(central_write.READ_SECONDS) as (client, deadline):
        found = central_api.request(target, "GET", "/api/v1/clientes", client=client, deadline=deadline).get("clients")
    return [c for c in found if isinstance(c, dict) and isinstance(c.get("name"), str)] if isinstance(found, list) else []


def plan(connection: sqlite3.Connection, target: central_api.Connection, items: list[dict], doubtful: Callable[[str], bool],
         anyway: set[str]) -> Batch:
    """Each ticked client as it will be created, checked against Central's clients read now."""
    remote = _remote(target)
    operations, skipped, warnings, names = [], [], [], set()
    for item in items:
        key = item["key"]
        source = _source(connection, key)
        if isinstance(source, str):
            skipped.append({"key": key, "name": item.get("name") or "—", "reason": source})
            continue
        origin, data, local_id, crmdev_id = source
        if item.get("name"):
            data["name"] = item["name"]
        try:
            body = {n: central_write._client_value(n, v) for n, v in data.items()}
        except ChangeError as error:
            skipped.append({"key": key, "name": data.get("name") or "—", "reason": str(error)})
            continue
        body = {n: v for n, v in body.items() if v is not None}
        existing = next((c for c in remote if _same(c, body)), None)
        if existing is not None:
            skipped.append({"key": key, "name": body["name"], "reason": f"Central ya tiene «{existing['name'][:200]}» con ese nombre, NIF o correo: enlázalo en vez de crear otro."})
            continue
        if clients.same_name(body["name"]) in names:
            skipped.append({"key": key, "name": body["name"], "reason": "Va otro con el mismo nombre en este envío."})
            continue
        if doubtful(key):
            if key not in anyway:
                skipped.append({"key": key, "name": body["name"], "reason": "Un envío anterior no recibió respuesta y puede haberse creado: revisa Central antes."})
                continue
            warnings.append(f"«{body['name']}»: un envío anterior pudo crearlo ya; si sigues, puede quedar repetido.")
        names.add(clients.same_name(body["name"]))
        operations.append(NewClient(key, origin, body, local_id, crmdev_id))
    return Batch(operations, skipped, warnings)


def send(target: central_api.Connection, batch: Batch, doubt: Callable[[str], None], pause: float | None = None) -> list[dict]:
    """Creates them one after another, reading Central's clients again first. Each result: `sent` (with its new
    `id`), `skipped` (it appeared meanwhile), `unknown`, `error` or `waiting` (Central asked to wait)."""
    pause = PAUSE_SECONDS if pause is None else pause
    remote = _remote(target)
    results, wrote = [], False
    for index, op in enumerate(batch.operations):
        result = {"key": op.key, "title": op.title, "origin": op.origin, "localId": op.local_id, "crmdevId": op.crmdev_id}
        results.append(result)
        if any(_same(c, op.body) for c in remote):
            result.update(outcome="skipped", message="Ya apareció en Central: no se crea otro.")
            continue
        if wrote and pause:
            time.sleep(pause)
        try:
            data = central_api.write(target, "POST", "/api/v1/clientes", op.body)
        except central_api.CentralConflict:
            wrote = True
            result.update(outcome="skipped", message="Central ya tiene un cliente con ese nombre: no se crea otro.")
            continue
        except central_api.CentralApiError as error:
            wrote = True
            if error.status == "busy":
                result.update(outcome="waiting", message="Central pide esperar: no se ha enviado.")
                for rest in batch.operations[index + 1:]:
                    results.append({"key": rest.key, "title": rest.title, "origin": rest.origin, "outcome": "waiting",
                                    "message": "Central pide esperar: no se ha enviado."})
                break
            if error.status in ("unreachable", "error"):
                doubt(op.key)
                result.update(outcome="unknown", message="Central no respondió a tiempo y puede haberse creado: revísalo antes de repetirlo.")
            else:
                result.update(outcome="error", message=str(error))
            continue
        wrote = True
        made = data.get("client") if isinstance(data.get("client"), dict) else {}
        result["outcome"] = "sent"
        if isinstance(made.get("id"), str) and ID.fullmatch(made["id"]):
            result["id"] = made["id"]
    return results
