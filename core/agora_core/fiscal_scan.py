"""The invoices already in a fiscal folder, for the quarterly register: received ones in «Facturas
Entrantes» and issued ones in «Facturas Salientes», wherever they sit (the quarter comes from the folder
names, as in the tidying plan). Each PDF is read once with the isolated extractor and local rules, and
read again only if it changes. Nothing in the folder is modified."""

import json
import re
import sqlite3
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import fiscal_folder, invoice_extract
from .fiscal import ISSUED, RECEIVED

DOCS = {".pdf", ".png", ".jpg", ".jpeg", ".heic"}


def _files(root: Path, top: str, year: int, quarter: int):
    base = root / top
    if not base.is_dir() or base.is_symlink():
        return
    for path in sorted(base.rglob("*")):
        if path.is_symlink() or not path.is_file() or path.suffix.lower() not in DOCS or path.name.startswith("."):
            continue
        folders = list(path.relative_to(base).parts[:-1])
        try:
            found_year, found_quarter, rest = fiscal_folder._where(folders)
        except fiscal_folder.Unclear:
            continue
        if (found_year, found_quarter) == (year, quarter):
            yield path, rest


_READING: set[tuple[int, str]] = set()
_READING_LOCK = threading.Lock()


def _cached(connection: sqlite3.Connection, folder_id: int, root: Path, path: Path) -> dict | None:
    stat = path.stat()
    row = connection.execute("SELECT size, mtime, fields FROM fiscal_file WHERE folder_id = ? AND path = ?",
                             (folder_id, str(path.relative_to(root)))).fetchone()
    return json.loads(row["fields"]) if row and row["size"] == stat.st_size and row["mtime"] == stat.st_mtime else None


def read_in_background(database, folder_id: int, root: Path, paths: list[Path]) -> None:
    """Reads the PDFs not read yet, four at a time, without holding up the request that found them."""
    with _READING_LOCK:
        todo = [p for p in paths if (folder_id, str(p)) not in _READING]
        _READING.update((folder_id, str(p)) for p in todo)
    if not todo:
        return

    def one(path: Path) -> None:
        try:
            with database() as connection:
                _read(connection, folder_id, root, path)
        except Exception:  # noqa: BLE001 - a file that cannot be read is simply left unread
            pass
        finally:
            with _READING_LOCK:
                _READING.discard((folder_id, str(path)))

    def run() -> None:
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(one, todo))
    threading.Thread(target=run, daemon=True).start()


def reading(folder_id: int) -> int:
    with _READING_LOCK:
        return sum(1 for f, _ in _READING if f == folder_id)


def _read(connection: sqlite3.Connection, folder_id: int, root: Path, path: Path) -> dict:
    relative = str(path.relative_to(root))
    stat = path.stat()
    cached = _cached(connection, folder_id, root, path)
    if cached is not None:
        return cached
    fields: dict = {"image": path.suffix.lower() != ".pdf"}
    if not fields["image"]:
        text = invoice_extract.pdf_text(path.read_bytes())
        fields |= invoice_extract.fields(text) | invoice_extract.breakdown(text)
    connection.execute("INSERT OR REPLACE INTO fiscal_file (folder_id, path, size, mtime, fields) VALUES (?, ?, ?, ?, ?)",
                       (folder_id, relative, stat.st_size, stat.st_mtime, json.dumps(fields)))
    return fields


def _name(path: Path, rest: list[str]) -> str:
    """Who it is from or for: the supplier's folder when there is one, else the file name tidied up."""
    if rest:
        return rest[-1]
    stem = re.sub(r"[_\-]+", " ", path.stem)
    return re.sub(r"\s+", " ", re.sub(r"\b\d{4}[-/]\d{2}[-/]\d{2}\b|\b\d{5,}\b", "", stem)).strip()[:80] or path.stem[:80]


def _day(fields: dict, start: str, end: str) -> tuple[str, bool]:
    day = fields.get("issuedOn")
    return (day, False) if day and start <= day <= end else (start, True)


def scan(connection: sqlite3.Connection, folder_id: int, root: Path, year: int, quarter: int, start: str, end: str,
         known: set[str]) -> tuple[list[dict], list[dict], list[Path]]:
    """(issued rows, received rows, files still to read) found in the folder for that quarter; `known` are
    paths already in the register, which are not counted twice. Only what was already read is used; the
    rest is returned so it can be read in the background."""
    issued = list(_files(root, ISSUED, year, quarter))
    received = [(p, r) for p, r in _files(root, RECEIVED, year, quarter) if str(p.relative_to(root)) not in known]
    pending, read = [], {}
    for path, _ in issued + received:
        fields = _cached(connection, folder_id, root, path)
        if fields is None:
            pending.append(path)
        else:
            read[path] = fields
    # The user's own tax id is on every invoice (as issuer or as customer): it is never the other party's.
    counts = Counter(t for f in read.values() for t in f.get("taxIds", []))
    own = {t for t, n in counts.items() if n >= max(3, len(read) // 2)}

    def other(fields: dict) -> str | None:
        return next((t for t in fields.get("taxIds", [fields.get("taxId")]) if t and t not in own), None)
    income, expenses = [], []
    for path, rest in issued:
        if path not in read:
            continue
        fields = read[path]
        day, guessed = _day(fields, start, end)
        base, total = fields.get("base"), fields.get("total")
        vat_rate, irpf_rate = fields.get("vatRate") or 0.0, fields.get("withholdingRate") or 0.0
        if base is None and total is not None:  # total = base + VAT − withholding
            base = str(round(float(total) / (1 + vat_rate - irpf_rate), 2))
        income.append({"date": day, "number": fields.get("number") or path.stem[:30], "client": _name(path, rest), "taxId": other(fields) or "",
                       "concept": str(path.relative_to(root)), "base": float(base) if base is not None else None,
                       "vatRate": vat_rate, "withholdingRate": irpf_rate, "total": total, "currency": fields.get("currency") or "EUR",
                       "guessedDate": guessed, "file": str(path.relative_to(root))})
    for path, rest in received:
        if path not in read:
            continue
        fields, relative = read[path], str(path.relative_to(root))
        day, guessed = _day(fields, start, end)
        notes = [n for n, on in (("Factura en imagen: revisa los importes", fields.get("image")),
                                 ("Fecha no leída: puesta al inicio del trimestre", guessed),
                                 ("Sin IVA desglosado", not fields.get("image") and fields.get("vat") is None)) if on]
        expenses.append({"id": f"archivo:{relative}", "doubts": notes, "issuedOn": day, "supplier": _name(path, rest), "taxId": other(fields),
                         "number": fields.get("number") or "", "concept": relative, "base": fields.get("base"), "vat": fields.get("vat"),
                         "total": fields.get("total") or "0", "currency": fields.get("currency") or "EUR", "notes": "; ".join(notes), "file": relative})
    return income, expenses, pending
