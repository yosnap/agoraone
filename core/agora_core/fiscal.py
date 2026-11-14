"""The user's fiscal folder and the invoices filed in it.

AgoraOne only touches the one folder the user chose in Settings (never the home folder or the root of
iCloud Drive), and every path is resolved and checked to stay inside it, so a link cannot lead elsewhere.
Received invoices go to `Facturas Entrantes/<year>/<N>T/`, named by date, supplier and total. Nothing is
ever overwritten or deleted: a name in use gets a suffix."""

import hashlib
import json
import os
import re
import sqlite3
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .db import now

FOLDER_SETTING = "fiscal.folder"
RECEIVED, ISSUED = "Facturas Entrantes", "Facturas Salientes"
ICLOUD = Path("Library") / "Mobile Documents" / "com~apple~CloudDocs"  # relative to the home folder
MAX_FILE = 15 * 1024 * 1024


class FiscalError(ValueError):
    pass


def check_folder(value: str, home: Path | None = None) -> Path:
    """A folder the user may choose: absolute, existing, inside the home folder, and neither the home folder,
    a folder that contains iCloud Drive or other personal folders, nor anything hidden or under ~/Library
    other than inside iCloud Drive."""
    home = (home or Path.home()).resolve()
    expanded = Path(os.path.expanduser(value.strip()))
    if not expanded.is_absolute():
        raise FiscalError("Escribe la ruta completa de la carpeta.")
    try:
        folder = expanded.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise FiscalError("Esa carpeta no existe.") from error
    if not folder.is_dir():
        raise FiscalError("Eso no es una carpeta.")
    icloud = home / ICLOUD
    protected = [home, icloud, home / "Documents", home / "Desktop", home / "Downloads"]
    refuse = FiscalError("Elige la subcarpeta de tu actividad, no la carpeta personal, la raíz de iCloud Drive ni una carpeta que las contenga.")
    if home not in folder.parents or any(folder == p or folder in p.parents for p in protected):
        raise refuse
    relative = folder.relative_to(home)
    if any(part.startswith(".") for part in relative.parts):
        raise refuse
    if relative.parts[0] == "Library" and icloud not in folder.parents:
        raise refuse
    return folder


def folder(connection: sqlite3.Connection) -> Path | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (FOLDER_SETTING,)).fetchone()
    if row is None:
        return None
    try:
        return check_folder(json.loads(row["value"]))
    except FiscalError:
        return None


def save_folder(connection: sqlite3.Connection, value: str | None) -> Path | None:
    if value is None:
        connection.execute("DELETE FROM setting WHERE key = ?", (FOLDER_SETTING,))
        return None
    chosen = check_folder(value)
    connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                       (FOLDER_SETTING, json.dumps(str(chosen))))
    return chosen


def inside(root: Path, relative: str) -> Path:
    """The absolute path of `relative` within the root, refusing anything that would leave it (.., links)."""
    if not relative or relative.startswith(("/", "~")) or "\x00" in relative:
        raise FiscalError("Ruta no válida.")
    target = (root / relative).resolve()
    if root != target and root not in target.parents:
        raise FiscalError("Esa ruta sale de la carpeta fiscal.")
    return target


def quarter_of(day: str) -> tuple[int, int]:
    parsed = date.fromisoformat(day)
    return parsed.year, (parsed.month - 1) // 3 + 1


def amount(value) -> str | None:
    """A decimal amount as text ("1234.50"), from "1.234,50", "1,234.50", "12,5 €" or a number."""
    if value is None or value == "":
        return None
    text = re.sub(r"[^\d,.\-]", "", str(value))
    if re.fullmatch(r"-?\d{1,3}(\.\d{3})+", text):  # «1.234» is a thousand separator in Spain
        text = text.replace(".", "")
    elif "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".") if text.rfind(",") > text.rfind(".") else text.replace(",", "")
    elif "," in text:
        text = text.replace(".", "").replace(",", ".") if re.search(r",\d{1,2}$", text) else text.replace(",", "")
    try:
        return str(Decimal(text).quantize(Decimal("0.01")))
    except InvalidOperation:
        return None


def _safe_name(text: str) -> str:
    text = "".join(c for c in unicodedata.normalize("NFC", text) if unicodedata.category(c) not in ("Cf", "Cc"))
    text = re.sub(r"[/\\:*?\"<>|\x00-\x1f]+", " ", text)
    return re.sub(r"\s+", " ", text).strip(" .")[:60] or "Proveedor"


def destination(supplier: str, issued_on: str, total: str, direction: str = "received") -> str:
    """Where a new invoice goes, relative to the fiscal folder."""
    year, quarter = quarter_of(issued_on)
    shown = total.replace(".", ",")
    return f"{RECEIVED if direction == 'received' else ISSUED}/{year}/{quarter}T/{issued_on} {_safe_name(supplier)} {shown}.pdf"


def _free(path: Path, taken: set[str] | None = None, root: Path | None = None) -> Path:
    """The first name not used on disk (nor by an invoice already filed, when `taken` is given)."""
    def used(candidate: Path) -> bool:
        return candidate.exists() or (taken is not None and root is not None and str(candidate.relative_to(root)) in taken)
    if not used(path):
        return path
    for n in range(2, 100):
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not used(candidate):
            return candidate
    raise FiscalError("Hay demasiados archivos con ese nombre.")


def move_exclusive(source: Path, target: Path) -> None:
    """Moves a file without ever replacing another: a hard link fails if the name appeared meanwhile."""
    os.link(source, target)
    source.unlink()


class Duplicate(FiscalError):
    pass


def file_invoice(connection: sqlite3.Connection, root: Path, data: bytes, fields: dict, message_id: int | None, doubts: list[str]) -> dict:
    """Writes the PDF in its quarter (never over another file) and records the invoice, once per message and
    once per file."""
    if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-2048:] or len(data) > MAX_FILE:
        raise FiscalError("El archivo no es un PDF completo o es demasiado grande.")
    total = amount(fields.get("total"))
    issued_on = fields.get("issuedOn") or ""
    supplier = (fields.get("supplier") or "").strip()
    if not supplier or not total or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", issued_on):
        raise FiscalError("Faltan el proveedor, la fecha o el total.")
    try:
        year, quarter = quarter_of(issued_on)
    except ValueError as error:
        raise FiscalError("La fecha no es válida.") from error
    digest = hashlib.sha256(data).hexdigest()
    clash = connection.execute("SELECT path FROM invoice WHERE sha256 = ? OR (message_id IS NOT NULL AND message_id = ?)",
                               (digest, message_id)).fetchone()
    if clash:
        raise Duplicate(f"Esta factura ya está archivada en {clash['path']}.")
    taken = {row["path"] for row in connection.execute("SELECT path FROM invoice")}
    target = _free(inside(root, destination(supplier, issued_on, total)), taken, root)
    relative = str(target.relative_to(root))
    created = False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        inside(root, relative)  # the folders just made must still be inside
        with open(target, "xb") as handle:  # x: fails rather than replacing a file that appeared meanwhile
            created = True
            handle.write(data)
    except FileExistsError:
        raise
    except OSError as error:
        if created:
            target.unlink(missing_ok=True)  # only our own half-written file
        raise FiscalError("No se pudo escribir en la carpeta fiscal (¿disco lleno o iCloud sin conexión?).") from error
    tax_id = (fields.get("taxId") or "").strip().upper() or None
    currency = (fields.get("currency") or "EUR").upper()[:3]
    try:
        cursor = connection.execute(
            """INSERT INTO invoice (direction, message_id, supplier, tax_id, issued_on, base, vat, total, currency, notes, doubts,
                                    quarter, path, sha256, filed_at)
               VALUES ('received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (message_id, supplier[:120], tax_id, issued_on, amount(fields.get("base")), amount(fields.get("vat")), total, currency,
             (fields.get("notes") or None), json.dumps([d[:300] for d in doubts][:10], ensure_ascii=False), f"{year}-{quarter}T", relative,
             digest, now()),
        )
    except sqlite3.Error as error:
        target.unlink(missing_ok=True)  # the file we just wrote, nothing else
        raise FiscalError("No se pudo registrar la factura; no se ha guardado nada.") from error
    return {"id": cursor.lastrowid, "path": relative, "quarter": f"{year}-{quarter}T"}


def invoices(connection: sqlite3.Connection, quarter: str | None = None) -> list[dict]:
    rows = connection.execute(
        "SELECT * FROM invoice" + (" WHERE quarter = ?" if quarter else "") + " ORDER BY issued_on DESC, id DESC",
        (quarter,) if quarter else (),
    ).fetchall()
    return [{"id": r["id"], "direction": r["direction"], "messageId": r["message_id"], "supplier": r["supplier"], "taxId": r["tax_id"],
             "issuedOn": r["issued_on"], "base": r["base"], "vat": r["vat"], "total": r["total"], "currency": r["currency"],
             "notes": r["notes"], "doubts": json.loads(r["doubts"]), "quarter": r["quarter"], "path": r["path"]} for r in rows]
