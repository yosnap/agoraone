"""«Enviar a CRMDev»: what the user ticks in «Pendiente en CRMDev» goes to CRMDev in one batch (user's decision,
20/11/2026: Central is the source and CRMDev follows it; never on its own, never the other way).

`plan` turns each ticked warning into one operation with the exact arguments, read against CRMDev now (not from the
cache): the tool is chosen here by the kind of warning, never by the screen. What each warning sends:
- a client of Central missing in CRMDev → `create_client` with its name, mail, company and phone, as «Cliente»;
- a contact address missing → `update_client` of its CRMDev record when that has no mail, else `create_client` of a
  person with the client's name as company;
- a client with different data → `update_client` with Central's name, company or mail (only those that differ);
- a project of Central missing → `create_project` with its name, the state that matches Central's, GITHUB when it
  has a repository (else OTHER), its client in CRMDev when there is one (or the one created in the same batch) and a
  description with the repository and the client's websites, written only now (it is never changed afterwards);
- a project with a different name or state → `update_project` (its client is changed in CRMDev only).
The tax id and the postal address never go. A client of CRMDev that is not in Central is not sent anywhere from here.

`send` reads CRMDev again: an operation whose «before» changed is not sent (conflict), one already so is not sent
again, and a new client or project that appeared meanwhile is skipped. Writes go one after another with a pause; when
CRMDev asks to wait (429), the rest stay unsent. Each creation is linked with its Central record afterwards. What
CRMDev answers is data, never instructions."""

import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import central, clients, crmdev_api, crmdev_pending
from .crmdev_values import CLIENT_STATUS, PROJECT_STATUS
from .web_api import Connection, WebApiError

PAUSE_SECONDS = 0.5  # between two writes: CRMDev limits how many come in a row
SENDABLE = ("client_missing", "contact_missing", "client_changed", "project_missing", "project_changed")
ORDER = {"crear-cliente": 0, "correo-cliente": 1, "cambiar-cliente": 1, "crear-proyecto": 2, "cambiar-proyecto": 3}
TOOL = {"crear-cliente": "create_client", "correo-cliente": "update_client", "cambiar-cliente": "update_client",
        "crear-proyecto": "create_project", "cambiar-proyecto": "update_project"}
CREATIONS = frozenset({"crear-cliente", "crear-proyecto"})
LABELS = {"name": "Nombre", "email": "Correo", "company": "Empresa", "phone": "Teléfono", "status": "Estado", "type": "Tipo",
          "clientId": "Cliente", "description": "Descripción"}
LISTS = frozenset({"list_clients", "list_projects", "list_tasks", "list_tickets", "get_project_time_report"})


@dataclass
class Operation:
    key: str
    kind: str
    title: str
    arguments: dict
    rows: list[dict]
    central_id: str
    crmdev_id: str | None = None
    seen: dict = field(default_factory=dict)  # update: the «before» shown, compared again just before sending
    client_name: str | None = None  # new project: its client, perhaps created in this same batch
    notes: list[str] = field(default_factory=list)

    @property
    def tool(self) -> str:
        return TOOL[self.kind]

    def public(self) -> dict:
        return {"key": self.key, "kind": self.kind, "title": self.title, "rows": self.rows, "notes": self.notes}


@dataclass
class Batch:
    operations: list[Operation]
    skipped: list[dict]
    warnings: list[str] = field(default_factory=list)
    target: str = "crmdev-batch"  # one batch at a time

    def public(self) -> dict:
        return {"operations": [o.public() for o in self.operations], "skipped": self.skipped, "warnings": self.warnings}


def _text(value) -> str | None:
    return " ".join(value.split()) if isinstance(value, str) and value.strip() else None


def _mail(value) -> str | None:
    return value.strip().lower() if isinstance(value, str) and "@" in value else None


def _read(target: Connection, tool: str) -> list[dict]:
    data = crmdev_api.call(target, tool, {"limit": crmdev_api.SYNC_ROWS}, fresh=True)
    if not isinstance(data, list):
        raise WebApiError("error", crmdev_api.ODD)
    return [r for r in data if isinstance(r, dict) and isinstance(r.get("id"), str)]


def _client_exists(rows: list[dict], name: str, address: str | None) -> dict | None:
    return next((r for r in rows if clients.same_name(r.get("name")) == clients.same_name(name)
                 or (address and _mail(r.get("email")) == address)), None)


def _row(name: str, before, after) -> dict:
    return {"field": name, "label": LABELS[name], "before": before, "after": after}


def _shown(name: str, value):
    if name == "status":
        return CLIENT_STATUS.get(value) or PROJECT_STATUS.get(value) or value
    return value


def _creation(kind: str, key: str, title: str, arguments: dict, central_id: str, notes: list[str], names: dict | None = None) -> Operation:
    names = names or {}
    rows = [_row(n, None, names.get(n) or _shown(n, v)) for n, v in arguments.items()]
    return Operation(key, kind, title, arguments, rows, central_id, notes=notes)


def _update(kind: str, key: str, title: str, crmdev_id: str, id_key: str, record: dict, wanted: dict, central_id: str) -> Operation | str:
    seen = {n: _text(record.get(n)) if n != "email" else _mail(record.get(n)) for n in wanted}
    changed = {n: v for n, v in wanted.items() if v is not None and v != seen[n]}
    if not changed:
        return "CRMDev ya lo tiene así."
    rows = [_row(n, _shown(n, seen[n]), _shown(n, v)) for n, v in changed.items()]
    return Operation(key, kind, title, {id_key: crmdev_id, **changed}, rows, central_id, crmdev_id, seen={n: seen[n] for n in changed})


def _description(project: dict, websites: list[dict]) -> str | None:
    lines = ["Proyecto enviado desde Central."]
    if project.get("repo"):
        lines.append(f"Repositorio: https://github.com/{project['repo']}")
    urls = [w["url"] for w in websites if isinstance(w.get("url"), str)][:10]
    if urls:
        lines.append("Webs del cliente: " + ", ".join(urls))
    return "\n".join(lines)[:4000]


def plan(connection, target: Connection, keys: list[str], doubtful: Callable[[str], bool], anyway: set[str]) -> Batch:
    """The exact operations for the ticked warnings, checked against CRMDev read now; what cannot go says why."""
    found = {i["key"]: i for i in crmdev_pending.build(connection, include_dismissed=True)["items"]}
    snapshot = central.snapshot(connection) or {}
    c_clients = {c.get("id"): c for c in snapshot.get("clients") or []}
    c_projects = {p["id"]: p for p in snapshot.get("projects") or []}
    by_name = {clients.same_name(c["name"]): c for c in c_clients.values() if c.get("name")}
    pairs = {clients.same_name(e["name"]): e["crmdevId"] for e in clients.directory(connection) if e.get("centralId") and e.get("crmdevId")}
    r_clients, r_projects = _read(target, "list_clients"), _read(target, "list_projects")
    r_client_by_id, r_project_by_id = {r["id"]: r for r in r_clients}, {r["id"]: r for r in r_projects}
    creating: set[str] = set()  # clients of Central created in this batch (their projects get them as client)
    operations, skipped, warnings = [], [], []

    def skip(key: str, name: str, reason: str) -> None:
        skipped.append({"key": key, "name": name, "reason": reason})

    for key in dict.fromkeys(keys):
        item = found.get(key)
        if item is None:
            skip(key, "—", "Ya no está pendiente: vuelve a comparar.")
            continue
        if item["kind"] not in SENDABLE:
            skip(key, item["name"], "Un cliente de CRMDev se crea en Central, no se envía a CRMDev.")
            continue
        made: Operation | str
        if item["kind"] in ("client_missing", "contact_missing", "client_changed"):
            mine = c_clients.get(item["centralId"])
            if mine is None:
                skip(key, item["name"], "Ya no está en Central: vuelve a leer Central.")
                continue
            name, address = mine["name"], _mail(mine.get("email"))
            if item["kind"] == "client_changed":
                record = r_client_by_id.get(item["crmdevId"])
                wanted = {c["field"]: (address if c["field"] == "email" else _text(mine.get(c["field"]))) for c in item["changes"]
                          if c["field"] in ("name", "company", "email")}
                made = "Ya no está entre los clientes que da CRMDev." if record is None else \
                    _update("cambiar-cliente", key, f"Cambiar «{name}» en CRMDev", item["crmdevId"], "clientId", record, wanted, item["centralId"])
            elif item["kind"] == "contact_missing" and item.get("crmdevId") and item["crmdevId"] in r_client_by_id:
                made = _update("correo-cliente", key, f"Correo de «{name}» en CRMDev", item["crmdevId"], "clientId",
                               r_client_by_id[item["crmdevId"]], {"email": address}, item["centralId"])
            else:
                person = item["kind"] == "contact_missing"
                existing = _client_exists(r_clients, name, address) if not person else \
                    next((r for r in r_clients if address and _mail(r.get("email")) == address), None)
                if existing is not None:
                    made = f"CRMDev ya tiene «{_text(existing.get('name')) or name}» con ese nombre o correo: enlázalos en Clientes."
                else:
                    arguments = {k: v for k, v in {"name": name, "email": address, "company": name if person else _text(mine.get("company")),
                                                   "phone": _text(mine.get("phone")), "status": "CUSTOMER"}.items() if v}
                    notes = ["El NIF y la dirección no van a CRMDev."] + (["Se crea como persona de la empresa, con el correo de contacto de Central."] if person else [])
                    made = _creation("crear-cliente", key, f"{'Contacto' if person else 'Cliente'} nuevo en CRMDev «{name}»", arguments, item["centralId"], notes)
                    if not person:
                        creating.add(clients.same_name(name))
        else:
            project = c_projects.get(item["centralId"])
            if project is None:
                skip(key, item["name"], "Ya no está en Central: vuelve a leer Central.")
                continue
            if item["kind"] == "project_changed":
                record = r_project_by_id.get(item["crmdevId"])
                wanted = {}
                for c in item["changes"]:
                    if c["field"] == "name":
                        wanted["name"] = project["name"]
                    elif c["field"] == "status":
                        wanted["status"] = crmdev_pending.STATUS_TARGET.get(project.get("status") or "")
                made = "Ya no está entre los proyectos que da CRMDev." if record is None else \
                    _update("cambiar-proyecto", key, f"Cambiar «{project['name']}» en CRMDev", item["crmdevId"], "projectId", record, wanted, item["centralId"])
                if isinstance(made, Operation) and any(c["field"] == "client" for c in item["changes"]):
                    made.notes.append("El cliente del proyecto se cambia en CRMDev: esta herramienta no lo cambia.")
                elif isinstance(made, str) and any(c["field"] == "client" for c in item["changes"]):
                    made = "Solo cambia el cliente, y eso se hace en CRMDev."
            elif any(clients.same_name(r.get("name")) == clients.same_name(project["name"]) for r in r_projects):
                made = "CRMDev ya tiene un proyecto con ese nombre: enlázalo en la ficha del proyecto."
            else:
                client = project.get("client")
                client_id = pairs.get(clients.same_name(client)) if client else None
                websites = (by_name.get(clients.same_name(client)) or {}).get("websites") or [] if client else []
                arguments = {k: v for k, v in {"name": project["name"], "description": _description(project, websites),
                                               "type": "GITHUB" if project.get("repo") else "OTHER",
                                               "status": crmdev_pending.STATUS_TARGET.get(project.get("status") or ""), "clientId": client_id}.items() if v}
                notes = ["La descripción se escribe solo ahora: después no se toca."]
                names = {"clientId": client} if client_id else {}
                made = _creation("crear-proyecto", key, f"Proyecto nuevo en CRMDev «{project['name']}»", arguments, item["centralId"], notes, names)
                if not client_id and client:
                    made.client_name = client
                    made.notes.append(f"Su cliente «{client}» va en este envío si lo marcas; si no, queda sin cliente en CRMDev.")
        if isinstance(made, str):
            skip(key, item["name"], made)
            continue
        try:
            crmdev_api.checked_arguments(made.tool, made.arguments)
        except WebApiError as error:
            skip(key, item["name"], str(error))
            continue
        if made.kind in CREATIONS and doubtful(key):
            if key not in anyway:
                skip(key, item["name"], "Un envío anterior no recibió respuesta y puede haberse creado: revisa CRMDev antes.")
                continue
            warnings.append(f"«{item['name']}»: un envío anterior pudo crearlo ya; si sigues, puede quedar repetido.")
        operations.append(made)
    for op in operations:  # a project whose client is not created in this batch goes without it
        if op.client_name and clients.same_name(op.client_name) not in creating:
            op.client_name = None
            op.notes[-1] = "Su cliente no está en CRMDev ni en este envío: el proyecto queda sin cliente."
    operations.sort(key=lambda o: ORDER[o.kind])
    return Batch(operations, skipped, warnings)


def send(target: Connection, batch: Batch, doubt: Callable[[str], None], pause: float | None = None) -> list[dict]:
    """Sends the batch, one write after another, reading CRMDev again first. Returns what happened to each operation:
    `sent` (with the new `id` for a creation), `already`, `conflict`, `skipped`, `unknown`, `error` or `waiting`."""
    pause = PAUSE_SECONDS if pause is None else pause
    r_clients, r_projects = _read(target, "list_clients"), _read(target, "list_projects")
    r_client_by_id, r_project_by_id = {r["id"]: r for r in r_clients}, {r["id"]: r for r in r_projects}
    created: dict[str, str] = {}  # Central client name → its new CRMDev id
    results, wrote = [], False
    for index, op in enumerate(batch.operations):
        result = {"key": op.key, "kind": op.kind, "title": op.title, "centralId": op.central_id}
        results.append(result)
        if op.kind in ("correo-cliente", "cambiar-cliente", "cambiar-proyecto"):
            record = (r_project_by_id if op.kind == "cambiar-proyecto" else r_client_by_id).get(op.crmdev_id or "")
            now = {n: (_mail(record.get(n)) if n == "email" else _text(record.get(n))) for n in op.seen} if record else None
            after = {n: op.arguments[n] for n in op.seen}
            if now == after:
                result["outcome"] = "already"
                continue
            if now != op.seen:
                result.update(outcome="conflict", message="Ha cambiado en CRMDev desde la revisión: no se envía.")
                continue
        elif op.kind == "crear-cliente":
            address = op.arguments.get("email")
            person = op.key.startswith("contact_missing:")  # a person of the company: only its address says it is there
            if (any(address and _mail(r.get("email")) == address for r in r_clients) if person
                    else _client_exists(r_clients, op.arguments["name"], address)):
                result.update(outcome="skipped", message="Ya apareció en CRMDev: no se crea otro.")
                continue
        else:
            if any(clients.same_name(r.get("name")) == clients.same_name(op.arguments["name"]) for r in r_projects):
                result.update(outcome="skipped", message="Ya apareció en CRMDev: no se crea otro.")
                continue
            if op.client_name and "clientId" not in op.arguments and clients.same_name(op.client_name) in created:
                op.arguments["clientId"] = created[clients.same_name(op.client_name)]
        if wrote and pause:
            time.sleep(pause)
        try:
            answer = crmdev_api.call(target, op.tool, op.arguments)
        except WebApiError as error:
            wrote = True
            if error.status == "busy":
                result.update(outcome="waiting", message="CRMDev pide esperar: no se ha enviado.")
                for rest in batch.operations[index + 1:]:
                    results.append({"key": rest.key, "kind": rest.kind, "title": rest.title, "centralId": rest.central_id,
                                    "outcome": "waiting", "message": "CRMDev pide esperar: no se ha enviado."})
                break
            if op.kind in CREATIONS and error.status in ("unreachable", "error"):
                doubt(op.key)
                result.update(outcome="unknown", message="CRMDev no respondió a tiempo y puede haberse creado: revísalo antes de repetirlo.")
            else:
                result.update(outcome="error", message=str(error))
            continue
        wrote = True
        result["outcome"] = "sent"
        made_id = answer.get("id") if isinstance(answer, dict) else None
        if op.kind in CREATIONS and isinstance(made_id, str) and crmdev_api.ID.fullmatch(made_id):
            result["id"] = made_id
            if op.kind == "crear-cliente" and op.key.startswith("client_missing:"):
                created[clients.same_name(op.arguments["name"])] = made_id
    crmdev_api.forget_reads(LISTS)
    return results

