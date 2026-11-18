"""Changes to Central from AgoraOne's own views, through Central's write API (`POST`/`PATCH /api/v1/*`, never one
that deletes): a client's data, a note on a client or a project, a project's state and phase, a quote phase's state
and due date, and «Crear en Central» for a client kept only in AgoraOne.

Every change is planned first (`plan`, `new_client`): the core reads what Central has now, checks it is still what
the user read (the `version` Central gave the record) and returns the exact change, field by field, before and
after, with a warning for each contact field that would be emptied. What is sent later is exactly that body, kept by
the core under a single-use token (`routes_central_write`): the screen never names a path nor sends the body twice.
Only the fields listed here can be changed; anything else is refused before asking Central. Archiving a project or
unfixing its state is done in Central only (its API refuses both)."""

import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date

from . import central_api, clients
from .central_views import ID, revision

READ_SECONDS = 20
NOTE_MAX = 5000
CLIENT_FIELDS = {"name": ("Nombre", 120), "company": ("Empresa", 160), "email": ("Correo", 200), "phone": ("Teléfono", 40),
                 "taxId": ("NIF", 30), "address": ("Dirección", 500)}
CONTACT = ("company", "email", "phone", "taxId", "address")
PROJECT_STATUSES = {"ACTIVE": "Activo", "MAINTENANCE": "Mantenimiento", "DORMANT": "Parado", "ARCHIVED": "Archivo"}
EDITABLE_STATUSES = ("ACTIVE", "MAINTENANCE", "DORMANT")
PHASE_STATUSES = {"PENDING": "Pendiente", "IN_PROGRESS": "En curso", "DONE": "Hecha", "INVOICED": "Facturada"}
PROJECT_FIELDS = {"status": "Estado", "statusLocked": "Estado fijado a mano", "phase": "Fase"}
PHASE_FIELDS = {"status": "Estado", "dueDate": "Fecha prevista"}
KINDS = ("cliente", "cliente-nuevo", "nota", "proyecto", "fase")
_EMAIL = re.compile(r"[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
UNFIXED = "Sin fijarlo, el escáner de Central puede volver a calcular el estado en su próxima pasada."
FIXED = "El estado está fijado a mano en Central: seguirá fijado con el estado nuevo."


class ChangeError(ValueError):
    """A change that cannot be asked (a field not allowed, a value out of range): 422, Central is not asked."""


class StaleError(Exception):
    """What the user read is no longer what Central has: the change is not offered; `current` is what there is now."""

    def __init__(self, current: list[dict]):
        super().__init__("Ha cambiado en Central desde que lo leíste: revisa lo que hay ahora y vuelve a hacer el cambio.")
        self.current = current


@dataclass
class Change:
    """A change ready to send: the exact request and what the user is shown of it."""
    kind: str
    method: str
    path: str
    body: dict
    title: str
    rows: list[dict]
    target: str  # what it changes («proyecto:<id>»): two changes of the same thing are never sent at once
    notes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    local_id: int | None = None

    def public(self) -> dict:
        return {"kind": self.kind, "title": self.title, "rows": self.rows, "notes": self.notes, "warnings": self.warnings}

    def fields(self) -> list[str]:
        """The names of the fields it changes (for the action log: never their values)."""
        return sorted(row["field"] for row in self.rows)


# ---- Values ----------------------------------------------------------------------------------------------------

def _text(value, label: str, limit: int, required: bool = False, lines: bool = False) -> str | None:
    """A text field as Central keeps it: trimmed, empty as None, within its limit, without control characters."""
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ChangeError(f"«{label}» tiene que ser texto.")
    value = value.strip()
    allowed = "\n\t" if lines else ""
    if any(ord(c) < 32 and c not in allowed for c in value) or "\x7f" in value:
        raise ChangeError(f"«{label}» lleva caracteres no válidos.")
    if len(value) > limit:
        raise ChangeError(f"«{label}» pasa de {limit} caracteres, el máximo de Central.")
    if required and not value:
        raise ChangeError(f"«{label}» no puede quedar vacío.")
    return value or None


def _client_value(name: str, value) -> str | None:
    label, limit = CLIENT_FIELDS[name]
    text = _text(value, label, limit, required=name == "name", lines=name == "address")
    if name == "email" and text and not _EMAIL.fullmatch(text):
        raise ChangeError("El correo no es válido.")
    return text


def _day(value) -> str | None:
    if value is None or value == "":
        return None
    try:
        if not (isinstance(value, str) and value.isascii() and _DAY.fullmatch(value)) or not 2000 <= date.fromisoformat(value).year <= 2100:
            raise ValueError
    except ValueError:
        raise ChangeError("La fecha prevista tiene que ser un día AAAA-MM-DD que exista.") from None
    return value


def _shown(field_name: str, value) -> str | None:
    """A value as the user reads it: states with Central's words, yes or no, days as 20/11/2026; None is empty."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "Sí" if value else "No"
    if field_name == "status":
        return PROJECT_STATUSES.get(value) or PHASE_STATUSES.get(value) or str(value)[:40]
    if field_name == "dueDate" and isinstance(value, str) and _DAY.fullmatch(value[:10]):
        y, m, d = value[:10].split("-")
        return f"{d}/{m}/{y}"
    return str(value)[:5000]


def _rows(labels: dict[str, str], before: dict, after: dict) -> list[dict]:
    """The fields that really change, in the order of `labels`, before and after."""
    return [{"field": name, "label": label, "before": _shown(name, before.get(name)), "after": _shown(name, after[name]),
             "emptied": after[name] is None and before.get(name) is not None}
            for name, label in labels.items() if name in after and after[name] != before.get(name)]


def _check_keys(given: dict, allowed: set[str]) -> None:
    unknown = sorted(set(given) - allowed)
    if unknown:
        raise ChangeError(f"Campo no permitido: «{str(unknown[0])[:40]}».")


def _id(value, label: str = "El identificador") -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ChangeError(f"{label} no es válido.")
    return value


def _changes(given: dict, allowed: dict) -> dict:
    changes = given.get("changes")
    if not isinstance(changes, dict) or not changes:
        raise ChangeError("Indica qué quieres cambiar.")
    _check_keys(changes, set(allowed))
    return changes


# ---- Current state, as Central has it ----------------------------------------------------------------------------

def client_now(data: dict) -> dict:
    return {name: data.get(name) if isinstance(data.get(name), str) else None for name in CLIENT_FIELDS}


def project_now(data: dict) -> dict:
    return {"status": data.get("status") if data.get("status") in PROJECT_STATUSES else None, "statusLocked": data.get("statusLocked") is True,
            "phase": data.get("phase") if isinstance(data.get("phase"), str) else None}


def phase_now(data: dict) -> dict:
    due = data.get("dueDate")
    return {"status": data.get("status") if data.get("status") in PHASE_STATUSES else None,
            "dueDate": due[:10] if isinstance(due, str) and _DAY.fullmatch(due[:10]) else None}


def shown_now(kind: str, data: dict | None) -> list[dict]:
    """What Central has now of the fields that can be changed, to show after a conflict."""
    if not isinstance(data, dict):
        return []
    now, labels = {"cliente": (client_now, {k: v[0] for k, v in CLIENT_FIELDS.items()}), "proyecto": (project_now, PROJECT_FIELDS),
                   "fase": (phase_now, PHASE_FIELDS)}.get(kind, (None, {}))
    if now is None:
        return []
    values = now(data)
    return [{"field": name, "label": label, "value": _shown(name, values.get(name))} for name, label in labels.items()]


def _read(target: central_api.Connection, path: str) -> dict:
    with central_api.session(READ_SECONDS) as (client, deadline):
        return central_api.request(target, "GET", path, client=client, deadline=deadline)


def _fresh(kind: str, given_revision, current_revision: str | None, data: dict) -> str:
    """The version the user read, when it is still Central's; a StaleError with what there is now otherwise."""
    if not isinstance(given_revision, str) or revision(given_revision) is None:
        raise ChangeError("Falta la versión de la ficha que leíste: vuelve a abrirla.")
    if current_revision is None:
        raise ChangeError("Esta Central no permite cambios desde AgoraOne todavía (falta su API de escritura): actualízala.")
    if given_revision != current_revision:
        raise StaleError(shown_now(kind, data))
    return given_revision


# ---- Planning each change ----------------------------------------------------------------------------------------

def plan(target: central_api.Connection, given: dict) -> Change:
    """The exact change for what the screen asks, checked against Central's current state (one or two readings)."""
    kind = given.get("kind")
    if kind == "cliente":
        return _client(target, given)
    if kind == "proyecto":
        return _project(target, given)
    if kind == "fase":
        return _phase(target, given)
    if kind == "nota":
        return _note(target, given)
    raise ChangeError("Ese cambio no existe.")


def _client(target: central_api.Connection, given: dict) -> Change:
    _check_keys(given, {"kind", "id", "revision", "changes"})
    item = _id(given.get("id"))
    after = {name: _client_value(name, value) for name, value in _changes(given, CLIENT_FIELDS).items()}
    data = _read(target, f"/api/v1/clientes/{item}")
    before = client_now(data)
    version = _fresh("cliente", given.get("revision"), revision(data.get("version")), data)
    rows = _rows({k: v[0] for k, v in CLIENT_FIELDS.items()}, before, after)
    if not rows:
        raise ChangeError("No hay cambios: los datos son los mismos que en Central.")
    warnings = [f"Se vacía «{r['label']}» en Central: «{r['before']}» se pierde (Central no guarda el valor anterior)."
                for r in rows if r["emptied"] and r["field"] in CONTACT]
    body = {"version": version, **{r["field"]: after[r["field"]] for r in rows}}
    return Change("cliente", "PATCH", f"/api/v1/clientes/{item}", body, f"Cliente «{before['name'] or '—'}»", rows, f"cliente:{item}",
                  warnings=warnings)


def _project(target: central_api.Connection, given: dict) -> Change:
    _check_keys(given, {"kind", "id", "revision", "changes"})
    item = _id(given.get("id"))
    changes = _changes(given, PROJECT_FIELDS)
    after: dict = {}
    if "status" in changes:
        if changes["status"] == "ARCHIVED":
            raise ChangeError("Archivar un proyecto se hace en Central: quita sus auditorías, sus alertas y su monitor de Uptime Kuma.")
        if changes["status"] not in EDITABLE_STATUSES:
            raise ChangeError("El estado no es válido.")
        after["status"] = changes["status"]
    if "statusLocked" in changes:
        if changes["statusLocked"] is not True:
            raise ChangeError("Quitar el estado fijado se hace en Central: sin él, el escáner podría archivar el proyecto.")
        after["statusLocked"] = True
    if "phase" in changes:
        after["phase"] = _text(changes["phase"], "Fase", 80)
    data = _read(target, f"/api/v1/proyectos/{item}")
    before = project_now(data)
    version = _fresh("proyecto", given.get("revision"), revision(data.get("version")), data)
    notes: list[str] = []
    if "status" in after and after["status"] != before["status"]:
        if before["statusLocked"]:
            after["statusLocked"] = True  # Central asks for it to change a fixed state: it stays fixed
            notes.append(FIXED)
        elif after.get("statusLocked") is not True:
            notes.append(UNFIXED)
    rows = _rows(PROJECT_FIELDS, before, after)
    if not rows:
        raise ChangeError("No hay cambios: el proyecto ya está así en Central.")
    if any(r["field"] == "statusLocked" for r in rows):
        notes.append("Una vez fijado, el estado solo se puede dejar de fijar en Central.")
    body = {"version": version, **{r["field"]: after[r["field"]] for r in rows}}
    if "status" in body and before["statusLocked"]:
        body["statusLocked"] = True  # not a change (it was fixed), but Central needs it said to change a fixed state
    name = data.get("name") if isinstance(data.get("name"), str) else "—"
    return Change("proyecto", "PATCH", f"/api/v1/proyectos/{item}", body, f"Proyecto «{name[:200]}»", rows, f"proyecto:{item}", notes=notes,
                  warnings=[f"Se vacía «Fase» en Central: «{r['before']}» se pierde." for r in rows if r["emptied"]])


def _phase(target: central_api.Connection, given: dict) -> Change:
    _check_keys(given, {"kind", "id", "phaseId", "revision", "changes"})
    quote, phase = _id(given.get("id"), "El presupuesto"), _id(given.get("phaseId"), "El hito")
    changes = _changes(given, PHASE_FIELDS)
    after: dict = {}
    if "status" in changes:
        if changes["status"] not in PHASE_STATUSES:
            raise ChangeError("El estado del hito no es válido.")
        after["status"] = changes["status"]
    if "dueDate" in changes:
        after["dueDate"] = _day(changes["dueDate"])
    data = _read(target, f"/api/v1/presupuestos/{quote}")
    found = next((p for p in data.get("phases") or [] if isinstance(p, dict) and p.get("id") == phase), None)
    if found is None:
        raise central_api.CentralApiError("not_found", "Ese hito ya no está en el presupuesto.")
    before = phase_now(found)
    version = _fresh("fase", given.get("revision"), revision(found.get("version")), found)
    rows = _rows(PHASE_FIELDS, before, after)
    if not rows:
        raise ChangeError("No hay cambios: el hito ya está así en Central.")
    notes = []
    if "status" in after and after["status"] in ("DONE", "INVOICED") and before["status"] not in ("DONE", "INVOICED"):
        notes.append("Central apunta hoy como fecha en que se completó.")
    elif "status" in after and after["status"] in ("PENDING", "IN_PROGRESS") and before["status"] in ("DONE", "INVOICED"):
        notes.append("Central borra la fecha en que se completó.")
    body = {"version": version, **{r["field"]: after[r["field"]] for r in rows}}
    number = data.get("number") if isinstance(data.get("number"), str) else "presupuesto"
    label = found.get("name") if isinstance(found.get("name"), str) else "—"
    return Change("fase", "PATCH", f"/api/v1/presupuestos/{quote}/fases/{phase}", body, f"Hito «{label[:200]}» de {number[:40]}", rows,
                  f"fase:{phase}", notes=notes, warnings=["Se quita la fecha prevista del hito."] if any(r["emptied"] for r in rows) else [])


def _note(target: central_api.Connection, given: dict) -> Change:
    _check_keys(given, {"kind", "target", "id", "body"})
    where = given.get("target")
    if where not in ("cliente", "proyecto"):
        raise ChangeError("La nota va en un cliente o en un proyecto.")
    item = _id(given.get("id"))
    text = _text(given.get("body"), "La nota", NOTE_MAX, required=True, lines=True)
    data = _read(target, f"/api/v1/{'clientes' if where == 'cliente' else 'proyectos'}/{item}")
    name = data.get("name") if isinstance(data.get("name"), str) else "—"
    rows = [{"field": "body", "label": "Nota nueva", "before": None, "after": text, "emptied": False}]
    body = {"body": text, ("clientId" if where == "cliente" else "projectId"): item}
    return Change("nota", "POST", "/api/v1/notas", body, f"Nota en {'el cliente' if where == 'cliente' else 'el proyecto'} «{name[:200]}»", rows,
                  f"nota:{item}", notes=["Las notas no se cambian ni se borran desde AgoraOne: se corrigen en Central."])


def new_client(connection: sqlite3.Connection, given: dict) -> Change:
    """«Crear en Central» for a client kept only here: its name, company, mail, phone and tax id as they are. Never
    for one that is already one of Central's (linked, or the same by name, tax id or mail) nor before Central is read."""
    from . import central

    _check_keys(given, {"kind", "localId"})
    local_id = given.get("localId")
    if isinstance(local_id, bool) or not isinstance(local_id, int) or local_id < 1:
        raise ChangeError("El cliente no es válido.")
    own = clients.get(connection, local_id)
    if own is None:
        raise central_api.CentralApiError("not_found", "Ese cliente ya no está en AgoraOne.")
    if central.snapshot(connection) is None:
        raise ChangeError("Antes hay que leer los clientes de Central (Ajustes › Central) para no crearlo dos veces.")
    entry = next((e for e in clients.directory(connection) if e.get("localId") == local_id), None)
    if own["centralId"] or entry is None or entry["source"] != "local":
        raise ChangeError("Ese cliente ya está en Central: no se crea otra vez.")
    after = {"name": _client_value("name", own["name"]), **{name: _client_value(name, own[name]) for name in ("company", "email", "phone", "taxId")}}
    after = {name: value for name, value in after.items() if value is not None}
    rows = _rows({k: v[0] for k, v in CLIENT_FIELDS.items()}, {}, after)
    notes = ["Al crearlo, tu cliente queda enlazado con el de Central: se ve una sola vez.",
             "Sus dominios y notas se quedan solo en AgoraOne."]
    return Change("cliente-nuevo", "POST", "/api/v1/clientes", after, f"Cliente nuevo en Central «{after['name']}»", rows, f"cliente-nuevo:{local_id}",
                  notes=notes, local_id=local_id)
