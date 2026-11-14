"""Invoices typed by hand: only for a file of a fiscal folder that cannot be read in any way (unreadable, too
big, or a picture the model could not read). Everything AgoraOne can read goes into the quarter exactly as it
was read; a reading that is wrong is fixed in the reading, never by hand. The file itself is never touched."""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .fiscal import ISSUED, RECEIVED, FiscalError, amount, inside
from .invoice_ai import _day, _tax_id, _text

FIELDS = ("name", "taxId", "number", "issuedOn", "base", "vatRate", "vat", "withholdingRate", "withholding", "total", "currency")


def unrecognized(fields: dict | None, use_model: bool = True) -> bool:
    """True when nothing usable could be read from the file."""
    if not fields:
        return False
    return bool(fields.get("unreadable") or (fields.get("image") and not (use_model and fields.get("ai"))))


def clean(raw: dict) -> dict:
    """The typed data, checked: a date and a total are required; rates come in percent (21 → 0.21)."""
    day = _day(raw.get("issuedOn"))
    if not day:
        raise FiscalError("Escribe la fecha de la factura (AAAA-MM-DD).")
    total = amount(raw.get("total"))
    if total is None:
        raise FiscalError("Escribe el total de la factura.")
    found: dict = {"issuedOn": day, "total": total, "name": _text(raw.get("name"), 120), "number": _text(raw.get("number"), 40)}
    if raw.get("taxId"):
        found["taxId"] = _tax_id(raw["taxId"])
        if not found["taxId"]:
            raise FiscalError("Ese NIF no parece válido.")
    for key in ("base", "vat", "withholding"):
        found[key] = amount(raw.get(key)) if raw.get(key) not in (None, "") else None
        if raw.get(key) not in (None, "") and found[key] is None:
            raise FiscalError("Hay un importe que no se entiende.")
    for key in ("vatRate", "withholdingRate"):
        value = amount(raw.get(key)) if raw.get(key) not in (None, "") else None
        if value is not None and not 0 <= float(value) <= 100:
            raise FiscalError("Los tipos van en porcentaje, de 0 a 100.")
        found[key] = round(float(value) / 100, 4) if value is not None else None
    currency = (raw.get("currency") or "EUR").strip().upper()
    if len(currency) != 3 or not currency.isalpha():
        raise FiscalError("La moneda es un código de tres letras (EUR, USD…).")
    found["currency"] = currency
    return {key: found.get(key) for key in FIELDS}


def target(root: Path, relative: str) -> Path:
    path = inside(root, relative)
    top = path.relative_to(root).parts[:1]
    if top not in ((ISSUED,), (RECEIVED,)):
        raise FiscalError("Solo se pueden completar facturas de «Facturas Entrantes» o «Facturas Salientes».")
    if not path.is_file():
        raise FiscalError("Ese archivo ya no está en la carpeta.")
    return path


def save(connection: sqlite3.Connection, folder_id: int, root: Path, path: Path, fields: dict) -> None:
    stat = path.stat()
    connection.execute("INSERT OR REPLACE INTO fiscal_manual (folder_id, path, size, mtime, fields, saved_at) VALUES (?, ?, ?, ?, ?, ?)",
                       (folder_id, str(path.relative_to(root)), stat.st_size, stat.st_mtime, json.dumps(fields),
                        datetime.now(timezone.utc).isoformat(timespec="seconds")))


def remove(connection: sqlite3.Connection, folder_id: int, relative: str) -> None:
    connection.execute("DELETE FROM fiscal_manual WHERE folder_id = ? AND path = ?", (folder_id, relative))


def load(connection: sqlite3.Connection, folder_id: int, root: Path) -> dict[str, dict]:
    """{relative path: typed data} for the files that have not changed since they were typed."""
    found = {}
    for row in connection.execute("SELECT path, size, mtime, fields FROM fiscal_manual WHERE folder_id = ?", (folder_id,)):
        try:
            stat = (root / row["path"]).stat()
        except OSError:
            continue
        if stat.st_size == row["size"] and stat.st_mtime == row["mtime"]:
            found[row["path"]] = json.loads(row["fields"])
    return found


def as_read(fields: dict, typed: dict, issued: bool) -> dict:
    """The file's fields with the typed data in place of what the model would have read."""
    other = ("receiver", "receiverTaxId") if issued else ("issuer", "issuerTaxId")
    ai = {key: typed.get(key) for key in FIELDS if key not in ("name", "taxId")} | {other[0]: typed.get("name"), other[1]: typed.get("taxId")}
    return {**fields, "unreadable": False, "ai": ai, "manual": typed}
