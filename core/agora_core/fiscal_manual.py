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
    """True when nothing usable could be read from the file: unreadable, or a picture that, with the model on,
    the model already tried and could not read (with it off, nothing reads pictures)."""
    if not fields:
        return False
    if fields.get("unreadable"):
        return True
    if not fields.get("image"):
        return False
    return not use_model or (bool(fields.get("aiTried")) and not fields.get("ai"))


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
    _complete(found)
    currency = (raw.get("currency") or "EUR").strip().upper()
    if len(currency) != 3 or not currency.isalpha():
        raise FiscalError("La moneda es un código de tres letras (EUR, USD…).")
    found["currency"] = currency
    return {key: found.get(key) for key in FIELDS}


def _complete(found: dict) -> None:
    """What follows from what was typed: the base from the total and the rates, a tax amount from its rate (or
    the other way round); then base + VAT − withholding must give the total, as on any invoice."""
    money = lambda value: f"{value:.2f}"  # noqa: E731
    number = lambda key: float(found[key]) if found.get(key) is not None else None  # noqa: E731
    total, vat_rate, irpf_rate = float(found["total"]), found.get("vatRate"), found.get("withholdingRate")
    if found.get("base") is None:
        if vat_rate is not None:
            found["base"] = money(total / (1 + vat_rate - (irpf_rate or 0)))
        elif found.get("vat") is not None:
            found["base"] = money(total - number("vat") + (number("withholding") or 0))
    base = number("base")
    if base is None:
        if found.get("withholding") is not None or irpf_rate:
            raise FiscalError("Con IRPF, escribe también la base o el tipo de IVA.")
        return  # a receipt with only its total: registered without VAT shown, base equal to the total
    for amount_key, rate_key in (("vat", "vatRate"), ("withholding", "withholdingRate")):
        if found.get(amount_key) is None and found.get(rate_key) is not None:
            found[amount_key] = money(base * found[rate_key])
        elif found.get(rate_key) is None and found.get(amount_key) is not None and base:
            found[rate_key] = round(number(amount_key) / base, 4)
    parts = base + (number("vat") or 0) - (number("withholding") or 0)
    if abs(parts - total) > 0.02:
        raise FiscalError(f"Base, IVA e IRPF suman {parts:.2f}, no el total {total:.2f}: revísalos.")


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
