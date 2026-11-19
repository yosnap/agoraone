"""The «Presupuestos» module: Central's quotes read live from its API v1 (`/api/v1/presupuestos`, `/api/v1/tarifas`)
with a key that has the `presupuestos` permission, even with the «Central» module off. Quotes live in Central
(numbering, brand, PDF and Word): nothing is copied here.

Whatever Central answers is copied field by field, with free text scrubbed of IPs and user or key paths (Central
already does it; this is the second lock). A new draft is checked here against Central's own schema
(`createQuoteSchema`) and sent as it is, never changed on the way, so what the user confirmed is what Central gets;
it is always a draft (Central's `POST` never sends nor changes a state). A quote's PDF or Word is downloaded by the
core (type and size checked) into `<data>/central-documentos/` under a name made only from its number, and opened
with the system's program; those files are removed at start when older than a day."""

import os
import re
import subprocess
import tempfile
import time
from datetime import date
from pathlib import Path
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from . import central_api
from .system_open import open_path
from .central_views import ID, ViewError, _SECRET_PATH, _number, _plain, _rows, _text, revision

QUOTE_STATUSES = ("DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED")
PHASE_STATUSES = ("PENDING", "IN_PROGRESS", "DONE", "INVOICED")
DOCUMENTS = {"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
# What each kind of file starts with: a PDF says so, a Word file is a zip.
SIGNATURES = {"pdf": b"%PDF-", "docx": b"PK\x03\x04"}
MAX_DOCUMENT = 20 * 1024 * 1024
FOLDER = "central-documentos"
KEEP_SECONDS = 86400
READ_SECONDS = 20  # a list or a record: the screen waits for it
DOCUMENT_SECONDS = 90  # a record and its document, which Central renders on the fly
MAX_AMOUNT = 99_999_999.99  # Central's Decimal(10, 2)
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def _clean(value, limit: int) -> str | None:
    return _text(value, limit, _SECRET_PATH)


def _lines(values, limit: int = 1000) -> list[str]:
    return [line for line in (_clean(v, limit) for v in values[:50]) if line] if isinstance(values, list) else []


def _ref(value) -> dict | None:
    """A linked client or project: its id and name, nothing else."""
    if not isinstance(value, dict):
        return None
    return {"id": _plain(value.get("id"), 40) if isinstance(value.get("id"), str) and ID.fullmatch(value["id"]) else None, "name": _plain(value.get("name"))}


def _status(value, allowed: tuple[str, ...]) -> str | None:
    return value if value in allowed else None


def quote_row(row: dict) -> dict:
    """A quote of the list (Central's `listQuotes`): its total with VAT, and the highest when a price is a range."""
    return {"id": row["id"] if isinstance(row.get("id"), str) and ID.fullmatch(row["id"]) else None, "number": _plain(row.get("number"), 40),
            "title": _plain(row.get("title")), "client": _plain(row.get("client")), "status": _status(row.get("status"), QUOTE_STATUSES),
            "issuedAt": _plain(row.get("issuedAt"), 40), "validUntil": _plain(row.get("validUntil"), 40),
            "total": _number(row.get("total")), "totalMax": _number(row.get("totalMax"))}


def quote_record(data: dict) -> dict:
    """A whole quote (Central's `getQuote`): lines, payment milestones with their amount, base, VAT and total."""
    items = [{"description": _clean(i.get("description"), 500), "details": _clean(i.get("details"), 3000), "quantity": _number(i.get("quantity")),
              "unit": _plain(i.get("unit"), 30), "unitPrice": _number(i.get("unitPrice")), "priceMax": _number(i.get("priceMax"))}
             for i in _rows(data, "items")[:100]]
    phases = [{"id": p["id"] if isinstance(p.get("id"), str) and ID.fullmatch(p["id"]) else None, "revision": revision(p.get("version")),
               "name": _clean(p.get("name"), 200), "percent": _number(p.get("percent")), "amount": _number(p.get("amount")),
               "dueDate": _plain(p.get("dueDate"), 40), "status": _status(p.get("status"), PHASE_STATUSES), "completedAt": _plain(p.get("completedAt"), 40)}
              for p in _rows(data, "phases")[:50]]
    schedule = [{"when": _clean(s.get("when"), 200), "what": _clean(s.get("what"), 1000)} for s in _rows(data, "schedule")[:50]]
    return {**quote_row({**data, "client": None}), "client": _ref(data.get("client")), "project": _ref(data.get("project")),
            "vat": _number(data.get("vat")), "notes": _clean(data.get("notes"), 5000), "scope": _clean(data.get("scope"), 10000),
            "includes": _lines(data.get("includes")), "excludes": _lines(data.get("excludes")), "assumptions": _lines(data.get("assumptions")),
            "thirdPartyCosts": _clean(data.get("thirdPartyCosts"), 5000), "schedule": schedule, "items": items, "phases": phases,
            "base": _number(data.get("base")), "tax": _number(data.get("tax")), "baseMax": _number(data.get("baseMax"))}


def rate(row: dict) -> dict:
    return {"id": row["id"] if isinstance(row.get("id"), str) and ID.fullmatch(row["id"]) else None, "name": _plain(row.get("name")),
            "unit": _plain(row.get("unit"), 30), "price": _number(row.get("price"))}


# ---- Query parameters (ASCII and from closed lists, as the «Central» views) --------------------------------------

def list_params(given: dict[str, str]) -> dict:
    unknown = sorted(set(given) - {"cliente", "estado"})
    if unknown:
        raise ViewError(f"Parámetro no permitido: «{unknown[0][:40]}».")
    query = {}
    if "cliente" in given:
        value = given["cliente"].strip()
        if not 1 <= len(value) <= 200 or not value.isprintable():
            raise ViewError("El parámetro «cliente» no es válido.")
        query["cliente"] = value
    if "estado" in given:
        if given["estado"] not in QUOTE_STATUSES:
            raise ViewError("El parámetro «estado» no es válido.")
        query["estado"] = given["estado"]
    return query


def document_format(given: dict[str, str]) -> str:
    if set(given) != {"format"} or given["format"] not in DOCUMENTS:
        raise ViewError("El formato del documento es pdf o docx.")
    return given["format"]


# ---- Reading ---------------------------------------------------------------------------------------------------

def read_list(target: central_api.Connection, query: dict) -> dict:
    with central_api.session(READ_SECONDS) as (client, deadline):
        data = central_api.request(target, "GET", "/api/v1/presupuestos", query or None, client=client, deadline=deadline)
    rows = [quote_row(q) for q in _rows(data, "quotes")]
    if query.get("cliente"):
        # Central matches «cliente» as «contains»: only that client's own quotes are shown.
        wanted = query["cliente"].casefold()
        rows = [q for q in rows if (q["client"] or "").casefold() == wanted]
    return {"quotes": rows}


def read_item(target: central_api.Connection, item: str) -> dict:
    with central_api.session(READ_SECONDS) as (client, deadline):
        return quote_record(central_api.request(target, "GET", f"/api/v1/presupuestos/{item}", client=client, deadline=deadline))


def read_rates(target: central_api.Connection) -> dict:
    with central_api.session(READ_SECONDS) as (client, deadline):
        data = central_api.request(target, "GET", "/api/v1/tarifas", client=client, deadline=deadline)
    return {"rates": [rate(r) for r in _rows(data, "rates")[:500]]}


# ---- Documents -------------------------------------------------------------------------------------------------

class DocumentError(RuntimeError):
    """The document came but could not be kept or opened on this computer."""


# Names Windows keeps for its devices, with or without an extension: never a file of ours.
_RESERVED = re.compile(r"(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])", re.I)
SUFFIXES = 20  # copies tried when the file is open in another program (Windows does not let it be replaced)


def file_name(number, item: str) -> str:
    """The name of the saved file: only letters, digits and dashes of Central's number (P-2026-001), never a «/»,
    «..» nor a name Windows reserves; the start of the id when the number has nothing usable."""
    clean = re.sub(r"[^A-Za-z0-9-]", "", number if isinstance(number, str) else "")[:40].strip("-")
    if not clean or _RESERVED.fullmatch(clean):
        return f"presupuesto-{item[:12]}"
    return clean


def documents_dir(data_dir: Path) -> Path:
    return data_dir / FOLDER


OPEN = open_path  # tests replace it


def _same(path: Path, content: bytes) -> bool:
    try:
        return path.is_file() and path.stat().st_size == len(content) and path.read_bytes() == content
    except OSError:
        return False


def _keep(folder: Path, stem: str, kind: str, content: bytes) -> str:
    """Writes the document under its name, or reuses it when it is already there with the same bytes. When the name
    is taken by a copy open in another program (Word on Windows), the next free «-2», «-3»… is used."""
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    for n in range(1, SUFFIXES + 1):
        name = f"{stem}.{kind}" if n == 1 else f"{stem}-{n}.{kind}"
        if _same(folder / name, content):
            return name
        handle, temporary = tempfile.mkstemp(dir=folder, prefix=".descarga-")
        try:
            with os.fdopen(handle, "wb") as out:
                out.write(content)
            os.replace(temporary, folder / name)
            return name
        except PermissionError:
            Path(temporary).unlink(missing_ok=True)
            continue
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
    raise DocumentError("El documento está abierto en otro programa: ciérralo y vuelve a intentarlo.")


def open_document(target: central_api.Connection, item: str, kind: str, data_dir: Path) -> str:
    """Downloads a quote's PDF or Word, keeps it under `<data>/central-documentos/` and opens it. Returns the name."""
    with central_api.session(DOCUMENT_SECONDS) as (client, deadline):
        record = central_api.request(target, "GET", f"/api/v1/presupuestos/{item}", client=client, deadline=deadline)
        content = central_api.download(target, f"/api/v1/presupuestos/{item}/{kind}", DOCUMENTS[kind], MAX_DOCUMENT, client, deadline)
    if not content.startswith(SIGNATURES[kind]):
        raise central_api.CentralApiError("error", "Central devolvió un documento que no es un " + ("PDF." if kind == "pdf" else "Word."))
    folder = documents_dir(data_dir)
    try:
        name = _keep(folder, file_name(record.get("number"), item), kind, content)
    except OSError as error:
        raise DocumentError("No se pudo guardar el documento en este equipo.") from error
    try:
        OPEN(folder / name)
    except (OSError, subprocess.SubprocessError) as error:
        raise DocumentError("El documento se descargó, pero no se pudo abrir con el programa del sistema.") from error
    return name


def clean_documents(data_dir: Path, now: float | None = None) -> None:
    """At start: the downloaded documents older than a day (and any half-written one) are removed."""
    folder = documents_dir(data_dir)
    if not folder.is_dir():
        return
    limit = (now or time.time()) - KEEP_SECONDS
    for path in folder.iterdir():
        try:
            if path.is_file() and (path.name.startswith(".descarga-") or path.stat().st_mtime < limit):
                path.unlink(missing_ok=True)
        except OSError:
            continue  # one that cannot be removed now is tried again at the next start


# ---- A new draft, checked against Central's own schema ---------------------------------------------------------

Amount = Annotated[float, Field(ge=0, le=MAX_AMOUNT, allow_inf_nan=False)]


def _units(value: str) -> int:
    """Length as zod measures it (JavaScript's UTF-16 units): an emoji counts two."""
    return len(value.encode("utf-16-le")) // 2


def Chars(most: int, least: int = 0):  # noqa: N802 - a type, used as `Chars(200)`
    def check(value: str) -> str:
        if not least <= _units(value) <= most:
            raise ValueError(f"Un texto tiene que tener entre {least} y {most} caracteres." if least else f"Un texto tiene como mucho {most} caracteres.")
        return value
    return Annotated[str, AfterValidator(check)]


def _day_ok(value: str) -> bool:
    try:
        return bool(_DAY.fullmatch(value)) and 2000 <= date.fromisoformat(value).year <= 2100
    except ValueError:
        return False


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DraftItem(_Strict):
    description: Chars(500, 1)
    details: Chars(3000) | None = None
    unitPrice: Amount
    priceMax: Amount | None = None
    quantity: Amount = 1
    unit: Chars(30) | None = None

    @model_validator(mode="after")
    def _range(self):
        if self.priceMax is not None and self.priceMax < self.unitPrice:
            raise ValueError("El precio máximo no puede ser menor que el precio.")
        return self


class DraftPhase(_Strict):
    name: Chars(200, 1)
    percent: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)] | None = None
    dueDate: str | None = None

    @model_validator(mode="after")
    def _day(self):
        if self.dueDate is not None and not _day_ok(self.dueDate):
            raise ValueError("La fecha de un hito es un día AAAA-MM-DD entre 2000 y 2100.")
        return self


class DraftScheduleEntry(_Strict):
    when: Chars(200)
    what: Chars(1000)


Lines = Annotated[list[Chars(1000)], Field(max_length=50)]


class Draft(_Strict):
    """Central's `createQuoteSchema` (src/lib/api/quotes.ts) with the same limits, lengths counted as zod does; the
    client by its exact name or id."""
    client: Chars(200, 1)
    title: Chars(200, 1)
    items: Annotated[list[DraftItem], Field(min_length=1, max_length=100)]
    phases: Annotated[list[DraftPhase], Field(max_length=50)] | None = None
    scope: Chars(10000) | None = None
    includes: Lines | None = None
    excludes: Lines | None = None
    assumptions: Lines | None = None
    thirdPartyCosts: Chars(5000) | None = None
    schedule: Annotated[list[DraftScheduleEntry], Field(max_length=50)] | None = None
    vat: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)] | None = None
    notes: Chars(5000) | None = None
    validDays: Annotated[int, Field(ge=1, le=365)] = 30

    @model_validator(mode="after")
    def _filled(self):
        if not self.client.strip() or not self.title.strip() or any(not i.description.strip() for i in self.items):
            raise ValueError("Faltan el cliente, el título o el concepto de una partida.")
        return self

    def body(self) -> dict:
        """What goes to Central: only the fields that came, as they came (Central applies its own defaults)."""
        return self.model_dump(exclude_unset=True)


def draft_problem(errors: list[dict]) -> str:
    """The first problem of a draft in plain words (pydantic's own text is in English)."""
    first = errors[0] if errors else {}
    where = ".".join(str(part) for part in first.get("loc", ()))
    message = str(first.get("msg") or "")
    if message.startswith("Value error, "):
        return message.removeprefix("Value error, ")
    return f"El borrador no es válido ({where})." if where else "El borrador no es válido."
