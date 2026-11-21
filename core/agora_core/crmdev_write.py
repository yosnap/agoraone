"""Changes to CRMDev from AgoraOne's own views, through the closed list of `crmdev_api.WRITE_TOOLS` and never one
that deletes: a new task, a task's title, description, state and priority, a project's name, state and progress, a new
client, a client's name, mail, company and state, and a ticket's state, priority and category.

Every change is planned first (`plan`): the core reads now (not from the cache) the list the record was shown from,
finds the record, and returns the exact change field by field, before and after, with only what really changes.
CRMDev has no revisions, so on confirming (`check`) the record is read again and the values shown as «before» are
compared: if any of them changed, nothing is sent (StaleError, with what there is now). Only fields whose current
value the list gives can be changed: a client's notes and a project's description are changed in CRMDev only, and a
text longer than what AgoraOne shows is too. The tool sent is fixed by the kind of change (`KIND_TOOL`), never named
by the screen. What CRMDev answers is data: it is shown, compared and never read as instructions."""

import hashlib
from collections.abc import Callable
from dataclasses import dataclass, field

from . import crmdev_api
from .confirmed_change import ChangeError
from .crmdev_values import (CATEGORY, CLIENT_STATUS, PRIORITY, PROJECT_STATUS, TASK_STATUS, TICKET_STATUS, Field, choice, day, email, now_value,
                            progress, ref, shown, text)
from .web_api import Connection, WebApiError

TITLE, DESCRIPTION = 300, 4000
KIND_TOOL = {"tarea-nueva": "create_task", "tarea": "update_task", "proyecto": "update_project", "cliente-nuevo": "create_client",
             "cliente": "update_client", "ticket": "update_ticket", "cliente-desde-local": "create_client", "respuesta-ticket": "reply_ticket"}
KINDS = tuple(KIND_TOOL)
# The readings a change makes old (names of projects and clients are also shown in tasks, tickets and hours).
KIND_LISTS = {
    "tarea-nueva": frozenset({"list_tasks", "get_project_time_report"}), "tarea": frozenset({"list_tasks", "get_project_time_report"}),
    "proyecto": frozenset({"list_projects", "list_tasks", "list_tickets", "get_project_time_report"}),
    "cliente-nuevo": frozenset({"list_clients"}), "cliente": frozenset({"list_clients", "list_tickets"}), "ticket": frozenset({"list_tickets"}),
    "cliente-desde-local": frozenset({"list_clients"}), "respuesta-ticket": frozenset({"list_tickets"}),
}
REPLY = 2000
GONE = f"Ya no está entre los {crmdev_api.MAX_ROWS} más recientes de CRMDev: vuelve a leer, o cámbialo en CRMDev."


class ExistsError(Exception):
    """A new client CRMDev already has (same name or same mail): the existing one is offered instead."""

    def __init__(self, crmdev_id: str | None, name: str):
        super().__init__(f"CRMDev ya tiene este cliente como «{name}»: no se crea otro.")
        self.crmdev_id = crmdev_id
        self.name = name


class StaleError(Exception):
    """What the user was shown is no longer what CRMDev has: nothing is sent; `current` is what there is now."""

    def __init__(self, current: list[dict], message: str = "Ha cambiado en CRMDev: vuelve a revisar el cambio."):
        super().__init__(message)
        self.current = current


@dataclass
class Change:
    """A change ready to send: the exact arguments of its tool and what the user is shown of it."""
    kind: str
    arguments: dict
    title: str
    rows: list[dict]
    target: str  # what it changes («tarea:<id>»): two changes of the same thing are never sent at once
    scope: dict = field(default_factory=dict)  # the list the record is read from again
    item: str | None = None
    seen: dict = field(default_factory=dict)  # the «before» shown, compared again on confirming
    expected: dict = field(default_factory=dict)  # the «after»: found already so, the change is done
    notes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    local_id: int | None = None  # «Crear en CRMDev» of a client kept here: linked with it once created
    org: str | None = None  # the organization of CRMDev it goes to (the first one when None)

    @property
    def tool(self) -> str:
        return KIND_TOOL[self.kind]

    def public(self) -> dict:
        return {"kind": self.kind, "title": self.title, "rows": self.rows, "notes": self.notes, "warnings": self.warnings}

    def fields(self) -> list[str]:
        """The names of the fields it changes (for the action log: never their values)."""
        return sorted(row["field"] for row in self.rows)


# ---- What each kind of change takes --------------------------------------------------------------------------------

@dataclass(frozen=True)
class Update:
    noun: str
    list_tool: str
    id_key: str
    filters: dict[str, str]  # the filters of the list on screen: name the screen uses → argument of the list
    fields: dict[str, Field]
    name: str  # the field that names the record in the title
    note: str | None = None


UPDATES = {
    "tarea": Update("Tarea", "list_tasks", "taskId", {"estado": "status", "proyecto": "projectId"}, {
        "title": Field("Título", text("Título", TITLE, required=True), limit=TITLE),
        "description": Field("Descripción", text("Descripción", DESCRIPTION, lines=True), limit=DESCRIPTION),
        "status": Field("Estado", choice("Estado", TASK_STATUS), TASK_STATUS),
        "priority": Field("Prioridad", choice("Prioridad", PRIORITY), PRIORITY)}, "title"),
    "proyecto": Update("Proyecto", "list_projects", "projectId", {"estado": "status"}, {
        "name": Field("Nombre", text("Nombre", TITLE, required=True), limit=TITLE),
        "status": Field("Estado", choice("Estado", PROJECT_STATUS), PROJECT_STATUS),
        "progress": Field("Progreso", progress)}, "name", "La descripción del proyecto no se toca: se cambia en CRMDev."),
    "cliente": Update("Cliente", "list_clients", "clientId", {"estado": "status"}, {
        "name": Field("Nombre", text("Nombre", TITLE, required=True), limit=TITLE),
        "email": Field("Correo", email(empties=False), limit=200),
        "company": Field("Empresa", text("Empresa", TITLE), limit=TITLE),
        "status": Field("Estado", choice("Estado", CLIENT_STATUS), CLIENT_STATUS)}, "name", "Las notas del cliente no se tocan: se escriben en CRMDev."),
    "ticket": Update("Ticket", "list_tickets", "ticketId", {"estado": "status", "cliente": "clientId"}, {
        "status": Field("Estado", choice("Estado", TICKET_STATUS), TICKET_STATUS),
        "priority": Field("Prioridad", choice("Prioridad", PRIORITY), PRIORITY),
        "category": Field("Categoría", choice("Categoría", CATEGORY), CATEGORY)}, "title"),
}
NEW_TASK = {"title": Field("Título", text("Título", TITLE, required=True)), "description": Field("Descripción", text("Descripción", DESCRIPTION, lines=True)),
            "projectId": Field("Proyecto", ref("Proyecto")), "assigneeId": Field("Asignada a", ref("Asignada a")),
            "status": Field("Estado", choice("Estado", TASK_STATUS, True), TASK_STATUS),
            "priority": Field("Prioridad", choice("Prioridad", PRIORITY, True), PRIORITY), "dueDate": Field("Fecha límite", day)}
NEW_CLIENT = {"name": Field("Nombre", text("Nombre", TITLE, required=True)), "email": Field("Correo", email(empties=True)),
              "company": Field("Empresa", text("Empresa", TITLE)), "phone": Field("Teléfono", text("Teléfono", 40)),
              "status": Field("Estado", choice("Estado", CLIENT_STATUS, True), CLIENT_STATUS)}


def _check_keys(given: dict, allowed: set[str]) -> None:
    unknown = sorted(str(name) for name in set(given) - allowed)
    if unknown:
        raise ChangeError(f"Campo no permitido: «{unknown[0][:40]}».")


def _values(given: object, fields: dict[str, Field], required: bool = True) -> dict:
    if not isinstance(given, dict) or (required and not given):
        raise ChangeError("Indica qué quieres cambiar.")
    _check_keys(given, set(fields))
    return {name: fields[name].check(value) for name, value in given.items()}


def _rows_of(target: Connection, tool: str, arguments: dict, fresh: bool) -> list[dict]:
    data = crmdev_api.call(target, tool, {**arguments, "limit": crmdev_api.MAX_ROWS}, fresh=fresh)
    if not isinstance(data, list):
        raise WebApiError("error", crmdev_api.ODD)
    return [row for row in data if isinstance(row, dict)]


def _find(target: Connection, spec: Update, scope: dict, item: str, anywhere: bool = False) -> dict | None:
    """The record in the list it was shown from, read now; with `anywhere`, also in the whole list when it left that
    one (a change of state already applied moves it out of a list filtered by state)."""
    found = next((row for row in _rows_of(target, spec.list_tool, scope, True) if row.get("id") == item), None)
    if found is None and anywhere and scope:
        found = next((row for row in _rows_of(target, spec.list_tool, {}, True) if row.get("id") == item), None)
    return found


# ---- Planning and checking -----------------------------------------------------------------------------------------

def plan(target: Connection, given: dict) -> Change:
    """The exact change for what the screen asks, checked against what CRMDev has now (read without the cache)."""
    kind = given.get("kind")
    if kind in UPDATES:
        return _update(target, kind, given)
    if kind == "tarea-nueva":
        return _new_task(target, given)
    if kind == "cliente-nuevo":
        return _new_client(target, given)
    if kind == "respuesta-ticket":
        return _reply(target, given)
    raise ChangeError("Ese cambio no existe.")  # «cliente-desde-local» needs the database: `from_local`


def _update(target: Connection, kind: str, given: dict) -> Change:
    spec = UPDATES[kind]
    _check_keys(given, {"kind", "id", "list", "changes"})
    item = given.get("id")
    if not isinstance(item, str) or not crmdev_api.ID.fullmatch(item):
        raise ChangeError("El identificador no es válido.")
    shown_list = given.get("list") or {}
    if not isinstance(shown_list, dict) or any(name not in spec.filters for name in shown_list):
        raise ChangeError("Esa lista de CRMDev no existe.")
    scope = {spec.filters[name]: value for name, value in shown_list.items() if value not in (None, "")}
    try:
        crmdev_api.checked_arguments(spec.list_tool, scope)
    except WebApiError as error:
        raise ChangeError(str(error)) from None
    after = _values(given.get("changes"), spec.fields)
    row = _find(target, spec, scope, item)
    if row is None:
        raise WebApiError("not_found", f"{spec.noun} no está entre los {crmdev_api.MAX_ROWS} más recientes de esa lista de CRMDev: cámbialo en CRMDev.")
    before = {name: now_value(row, name) for name in spec.fields}
    for name in after:
        limit, current = spec.fields[name].limit, before[name]
        if limit is not None and isinstance(current, str) and len(current) > limit:
            raise ChangeError(f"«{spec.fields[name].label}» tiene ahora más de {limit} caracteres y aquí no se ve entero: cámbialo en CRMDev.")
    rows = [{"field": name, "label": f.label, "before": shown(f, before[name]), "after": shown(f, after[name]),
             "emptied": after[name] is None and before[name] is not None}
            for name, f in spec.fields.items() if name in after and after[name] != before[name]]
    if not rows:
        raise ChangeError("No cambia nada: CRMDev ya lo tiene así.")
    changed = [r["field"] for r in rows]
    label = str(now_value(row, spec.name) or "—")
    return Change(kind, {spec.id_key: item, **{name: after[name] for name in changed}}, f"{spec.noun} «{label[:200]}»", rows, f"{kind}:{item}",
                  scope=scope, item=item, seen={name: before[name] for name in changed}, expected={name: after[name] for name in changed},
                  notes=[spec.note] if spec.note else [],
                  warnings=[f"Se vacía «{r['label']}» en CRMDev: lo que tiene ahora se pierde." for r in rows if r["emptied"]])


def _named(target: Connection, tool: str, item: str | None, label: str, name_of: Callable[[dict], dict]) -> str | None:
    """The name of a project or member the new task points to, from the list the form offered (the core's cache)."""
    if item is None:
        return None
    found = next((name_of(row) for row in _rows_of(target, tool, {}, False) if name_of(row).get("id") == item), None)
    if found is None:
        raise ChangeError(f"«{label}» no está en CRMDev: vuelve a leer y elige otro.")
    name = found.get("name")
    return name.strip()[:TITLE] if isinstance(name, str) and name.strip() else item


def _created(kind: str, after: dict, fields: dict[str, Field], title: str, target_id: str, notes: list[str], names: dict | None = None) -> Change:
    sent = {name: value for name, value in after.items() if value is not None}
    names = names or {}
    rows = [{"field": name, "label": f.label, "before": None, "after": names.get(name) or shown(f, sent[name]), "emptied": False}
            for name, f in fields.items() if name in sent]
    return Change(kind, sent, title, rows, target_id, notes=notes)


def _new_task(target: Connection, given: dict) -> Change:
    _check_keys(given, {"kind", "values"})
    after = _values(given.get("values"), NEW_TASK)
    if after.get("title") is None:
        raise ChangeError("«Título» no puede quedar vacío.")
    names = {"projectId": _named(target, "list_projects", after.get("projectId"), "Proyecto", lambda row: row),
             "assigneeId": _named(target, "list_members", after.get("assigneeId"), "Asignada a",
                                       lambda row: row["user"] if isinstance(row.get("user"), dict) else {})}
    notes = ["Se crea a nombre de quien creó la clave en CRMDev.", "Sin estado ni prioridad, CRMDev la deja «Por hacer» y con prioridad media."]
    return _created("tarea-nueva", after, NEW_TASK, f"Tarea nueva «{after['title'][:200]}»", f"tarea-nueva:{after['title'].casefold()[:200]}", notes, names)


def same_name(value: object) -> str:
    return " ".join(value.split()).casefold() if isinstance(value, str) else ""


def _existing(target: Connection, name: str, address: str | None) -> None:
    """A client with that name or that exact mail among the newest in CRMDev, read now: ExistsError, never a second one."""
    for row in _rows_of(target, "list_clients", {}, True):
        mail = row.get("email")
        if same_name(row.get("name")) == same_name(name) or (address and isinstance(mail, str) and mail.strip().lower() == address.lower()):
            found = row.get("id") if isinstance(row.get("id"), str) and crmdev_api.ID.fullmatch(row["id"]) else None
            called = row.get("name") if isinstance(row.get("name"), str) and row["name"].strip() else name
            raise ExistsError(found, called.strip()[:200])


def _new_client(target: Connection, given: dict) -> Change:
    _check_keys(given, {"kind", "values"})
    after = _values(given.get("values"), NEW_CLIENT)
    if after.get("name") is None:
        raise ChangeError("«Nombre» no puede quedar vacío.")
    _existing(target, after["name"], after.get("email"))
    notes = [f"Se ha comprobado que no esté ya entre los {crmdev_api.MAX_ROWS} clientes más recientes de CRMDev, por nombre o por correo.",
             "Las notas y el origen se escriben en CRMDev.", "Sin estado, CRMDev lo deja como «Contacto»."]
    return _created("cliente-nuevo", after, NEW_CLIENT, f"Cliente nuevo en CRMDev «{after['name'][:200]}»", f"cliente-nuevo:{same_name(after['name'])[:200]}", notes)


def from_local(connection, target: Connection, given: dict) -> Change:
    """«Crear en CRMDev» for a client kept only here: its name, mail, company and phone as they are, and the state the
    user chose (Cliente by default). Checked against CRMDev's newest clients read now: one with the same name or mail is
    offered to link (ExistsError) instead of creating a second one. Never for a client already in CRMDev."""
    from . import clients

    _check_keys(given, {"kind", "localId", "status"})
    local_id = given.get("localId")
    if isinstance(local_id, bool) or not isinstance(local_id, int) or local_id < 1:
        raise ChangeError("El cliente no es válido.")
    own = clients.get(connection, local_id)
    if own is None:
        raise WebApiError("not_found", "Ese cliente ya no está en AgoraOne.")
    entry = next((e for e in clients.directory(connection) if e.get("localId") == local_id), None)
    if any(link["connector"] == "crmdev" and link["state"] == "linked" for link in own["links"]) or (entry is not None and entry["crmdevId"]):
        raise ChangeError("Ese cliente ya está en CRMDev: no se crea otra vez.")
    status = given.get("status") if given.get("status") is not None else "CUSTOMER"
    after = _values({"name": own["name"], "email": own["email"], "company": own["company"], "phone": own["phone"], "status": status}, NEW_CLIENT)
    _existing(target, after["name"], after.get("email"))
    notes = [f"Se ha comprobado que no esté ya entre los {crmdev_api.MAX_ROWS} clientes más recientes de CRMDev, por nombre o por correo.",
             "Al crearlo, tu cliente queda enlazado con el de CRMDev: se ve una sola vez.", "Su NIF, sus dominios y sus notas se quedan solo en AgoraOne."]
    change = _created("cliente-desde-local", after, NEW_CLIENT, f"Cliente nuevo en CRMDev «{after['name'][:200]}»", f"cliente-desde-local:{local_id}", notes)
    change.local_id = local_id
    return change


def _reply(target: Connection, given: dict) -> Change:
    """A reply to a ticket of the list on screen: the exact text and whether only the team sees it (a note) or the
    client too. The user says which every time: there is no default. CRMDev keeps it as a comment of the ticket."""
    _check_keys(given, {"kind", "id", "list", "content", "internal"})
    item = given.get("id")
    if not isinstance(item, str) or not crmdev_api.ID.fullmatch(item):
        raise ChangeError("El identificador no es válido.")
    internal = given.get("internal")
    if not isinstance(internal, bool):
        raise ChangeError("Di si es una nota interna o una respuesta al cliente.")
    content = text("Respuesta", REPLY, required=True, lines=True)(given.get("content"))
    if not content:
        raise ChangeError("Escribe la respuesta.")
    spec = UPDATES["ticket"]
    shown_list = given.get("list") or {}
    if not isinstance(shown_list, dict) or any(name not in spec.filters for name in shown_list):
        raise ChangeError("Esa lista de CRMDev no existe.")
    scope = {spec.filters[name]: value for name, value in shown_list.items() if value not in (None, "")}
    row = _find(target, spec, scope, item, anywhere=True)
    if row is None:
        raise WebApiError("not_found", f"El ticket no está entre los {crmdev_api.MAX_ROWS} más recientes de CRMDev: respóndelo en CRMDev.")
    title = str(now_value(row, "title") or "—")[:200]
    rows = [{"field": "isInternal", "label": "Quién la ve", "before": None, "after": "Solo el equipo (nota interna)" if internal else "El cliente",
             "emptied": False},
            {"field": "content", "label": "Respuesta", "before": None, "after": content, "emptied": False}]
    warnings = [] if internal else ["El cliente verá esta respuesta en su portal de CRMDev."]
    return Change("respuesta-ticket", {"ticketId": item, "content": content, "isInternal": internal}, f"Respuesta al ticket «{title}»", rows,
                  f"respuesta-ticket:{item}:{hashlib.sha256(content.encode()).hexdigest()[:12]}", scope=scope, item=item,
                  notes=["Se publica a nombre de quien creó la clave en CRMDev. Una respuesta no se puede borrar desde AgoraOne."], warnings=warnings)


def check(target: Connection, change: Change) -> bool:
    """Just before sending: True when CRMDev already has the change (nothing to send), False to send it; StaleError
    when what was shown as «before» changed meanwhile, ExistsError when the new client appeared meanwhile."""
    if change.kind in UPDATES:
        spec = UPDATES[change.kind]
        row = _find(target, spec, change.scope, change.item or "", anywhere=True)
        if row is None:
            raise StaleError([], GONE)
        now = {name: now_value(row, name) for name in change.seen}
        if now == change.seen:
            return False
        if now == change.expected:
            return True
        raise StaleError([{"field": name, "label": spec.fields[name].label, "value": shown(spec.fields[name], now[name])} for name in change.seen])
    if change.kind in ("cliente-nuevo", "cliente-desde-local"):
        _existing(target, change.arguments["name"], change.arguments.get("email"))
    if change.kind == "respuesta-ticket" and _find(target, UPDATES["ticket"], change.scope, change.item or "", anywhere=True) is None:
        raise StaleError([], GONE)
    return False
