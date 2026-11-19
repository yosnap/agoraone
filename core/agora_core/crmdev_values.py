"""The values of a change to CRMDev: each field's check (what the screen gives → what is sent, or a ChangeError before
asking CRMDev), how a value is shown to the user (states in Spanish, days as 20/11/2026) and how CRMDev's current value
is read for comparing. Lengths are AgoraOne's limits (what the views show whole), not CRMDev's."""

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

from . import crmdev_api
from .confirmed_change import ChangeError

TASK_STATUS = {"TODO": "Por hacer", "IN_PROGRESS": "En curso", "IN_REVIEW": "En revisión", "DONE": "Hecha", "CANCELLED": "Cancelada"}
PROJECT_STATUS = {"NOT_STARTED": "Sin empezar", "IN_PROGRESS": "En curso", "ON_HOLD": "En pausa", "COMPLETED": "Terminado", "CANCELLED": "Cancelado"}
CLIENT_STATUS = {"LEAD": "Contacto", "PROSPECT": "Posible cliente", "CUSTOMER": "Cliente", "INACTIVE": "Inactivo", "CHURNED": "Perdido"}
TICKET_STATUS = {"OPEN": "Abierto", "IN_PROGRESS": "En curso", "WAITING_CLIENT": "Esperando al cliente", "RESOLVED": "Resuelto", "CLOSED": "Cerrado"}
PRIORITY = {"LOW": "Baja", "MEDIUM": "Media", "HIGH": "Alta", "URGENT": "Urgente"}
CATEGORY = {"BUG": "Error", "FEATURE_REQUEST": "Petición de función", "QUESTION": "Pregunta", "SUPPORT": "Soporte", "BILLING": "Facturación",
            "PERFORMANCE": "Rendimiento", "SECURITY": "Seguridad", "OTHER": "Otra"}
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class Field:
    label: str
    check: Callable[[object], object]  # what the screen gives → the value sent (None: emptied, or left out of a creation)
    labels: dict[str, str] | None = None  # the Spanish words of an enumerated value
    limit: int | None = None  # a text: longer now in CRMDev than this, it is not changed here (it could not be shown whole)


def text(label: str, limit: int, required: bool = False, lines: bool = False, empties: bool = True) -> Callable[[object], object]:
    def check(value: object) -> str | None:
        value = "" if value is None else value
        if not isinstance(value, str):
            raise ChangeError(f"«{label}» tiene que ser texto.")
        value = value.strip()
        allowed = "\n\t" if lines else ""
        if any((ord(c) < 32 and c not in allowed) or c == "\x7f" for c in value):
            raise ChangeError(f"«{label}» lleva caracteres no válidos.")
        if len(value) > limit:
            raise ChangeError(f"«{label}» pasa de {limit} caracteres.")
        if not value and required:
            raise ChangeError(f"«{label}» no puede quedar vacío.")
        if not value and not empties:
            raise ChangeError(f"«{label}» no se puede vaciar desde AgoraOne (la API de CRMDev no lo permite): hazlo en CRMDev.")
        return value or None
    return check


def email(empties: bool) -> Callable[[object], object]:
    words = text("Correo", 200, empties=empties)

    def check(value: object) -> str | None:
        text = words(value)
        if text is not None and not EMAIL.fullmatch(text):
            raise ChangeError("El correo no es válido.")
        return text
    return check


def choice(label: str, labels: dict[str, str], optional: bool = False) -> Callable[[object], object]:
    def check(value: object) -> str | None:
        if optional and value in (None, ""):
            return None
        if not isinstance(value, str) or value not in labels:
            raise ChangeError(f"«{label}» no es válido.")
        return value
    return check


def progress(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        raise ChangeError("El progreso va de 0 a 100.")
    return value


def ref(label: str) -> Callable[[object], object]:
    def check(value: object) -> str | None:
        if value in (None, ""):
            return None
        if not isinstance(value, str) or not crmdev_api.ID.fullmatch(value):
            raise ChangeError(f"«{label}» no es válido.")
        return value
    return check


def day(value: object) -> str | None:
    if value in (None, ""):
        return None
    try:
        if not (isinstance(value, str) and value.isascii() and DAY.fullmatch(value)) or not 2000 <= date.fromisoformat(value).year <= 2100:
            raise ValueError
    except ValueError:
        raise ChangeError("La fecha límite tiene que ser un día AAAA-MM-DD que exista.") from None
    return value


def shown(spec: Field, value: object) -> str | None:
    if value is None:
        return None
    if spec.labels is not None:
        return spec.labels.get(str(value), str(value)[:40])
    if spec.check is progress:
        return f"{value} %"
    if spec.check is day and isinstance(value, str):
        y, m, d = value.split("-")
        return f"{d}/{m}/{y}"
    return str(value)


def now_value(row: dict, name: str) -> object:
    """A field as CRMDev has it now: text trimmed (empty is None), anything unexpected None."""
    value = row.get(name)
    if name == "progress":
        return value if isinstance(value, int) and not isinstance(value, bool) else None
    if isinstance(value, str):
        return value.strip() or None
    return None
