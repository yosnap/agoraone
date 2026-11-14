"""The invoices already in a fiscal folder, for the quarterly register: received ones in «Facturas
Entrantes» and issued ones in «Facturas Salientes», wherever they sit (the quarter comes from the folder
names, as in the tidying plan). Each PDF is read once with the isolated extractor and local rules, and
read again only if it changes. Nothing in the folder is modified."""

import hashlib
import json
import re
import sqlite3
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import fiscal_folder, invoice_extract
from .fiscal import ISSUED, MAX_FILE, RECEIVED

DOCS = {".pdf", ".png", ".jpg", ".jpeg", ".heic"}


def _files(root: Path, top: str, year: int, quarter: int, unplaced: list | None = None):
    """The documents of that quarter; those whose folders do not tell a quarter go to `unplaced`."""
    base = root / top
    if not base.is_dir() or base.is_symlink():
        return
    for path in sorted(base.rglob("*")):
        try:
            if path.is_symlink() or not path.is_file() or path.suffix.lower() not in DOCS or path.name.startswith("."):
                continue
        except OSError:
            continue
        folders = list(path.relative_to(base).parts[:-1])
        try:
            found_year, found_quarter, rest = fiscal_folder._where(folders)
        except fiscal_folder.Unclear:
            found_year = found_quarter = None
            rest = []
        if found_year is None or found_quarter is None:
            if unplaced is not None:
                unplaced.append(path)
            continue
        if (found_year, found_quarter) == (year, quarter):
            yield path, rest


_READING: set[tuple[int, str]] = set()
_READING_LOCK = threading.Lock()


def _cached(connection: sqlite3.Connection, folder_id: int, root: Path, path: Path) -> dict | None:
    try:
        stat = path.stat()
    except OSError:
        return {"unreadable": True}
    row = connection.execute("SELECT size, mtime, fields FROM fiscal_file WHERE folder_id = ? AND path = ?",
                             (folder_id, str(path.relative_to(root)))).fetchone()
    if not row or row["size"] != stat.st_size or row["mtime"] != stat.st_mtime:
        return None
    fields = json.loads(row["fields"])
    # Read again with newer rules (images and files too big are not read anyway).
    return fields if fields.get("v") == invoice_extract.VERSION or fields.get("image") or fields.get("tooBig") else None


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
                try:
                    _read(connection, folder_id, root, path)
                except Exception:  # noqa: BLE001 - kept as unreadable, so it is counted and never read in a loop
                    _remember(connection, folder_id, root, path, {"unreadable": True})
        except Exception:  # noqa: BLE001
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


def _remember(connection: sqlite3.Connection, folder_id: int, root: Path, path: Path, fields: dict) -> None:
    try:
        stat = path.stat()
    except OSError:
        return
    connection.execute("INSERT OR REPLACE INTO fiscal_file (folder_id, path, size, mtime, fields) VALUES (?, ?, ?, ?, ?)",
                       (folder_id, str(path.relative_to(root)), stat.st_size, stat.st_mtime, json.dumps(fields)))


def _read(connection: sqlite3.Connection, folder_id: int, root: Path, path: Path) -> dict:
    cached = _cached(connection, folder_id, root, path)
    if cached is not None:
        return cached
    fields: dict = {"image": path.suffix.lower() != ".pdf", "v": invoice_extract.VERSION}
    if path.stat().st_size > MAX_FILE:
        fields["unreadable"] = fields["tooBig"] = True
    else:
        data = path.read_bytes()
        fields["sha256"] = hashlib.sha256(data).hexdigest()
        if not fields["image"]:
            text = invoice_extract.pdf_text(data)
            if text.strip():
                fields |= invoice_extract.fields(text) | invoice_extract.breakdown(text)
            else:
                fields["unreadable"] = True  # scanned without text, protected or the extractor gave up
    _remember(connection, folder_id, root, path, fields)
    return fields


def _name(path: Path, rest: list[str]) -> str:
    """Who it is from or for: the supplier's folder when there is one, else the file name tidied up."""
    if rest:
        return rest[-1]
    stem = re.sub(r"[_\-]+", " ", path.stem)
    return re.sub(r"\s+", " ", re.sub(r"\b\d{4}[-/]\d{2}[-/]\d{2}\b|\b\d{5,}\b", "", stem)).strip()[:80] or path.stem[:80]


def _day(fields: dict, start: str, end: str) -> tuple[str, bool]:
    """The invoice's date, or another date of it within the quarter (a receipt issued later than the
    payment it records), or the start of the quarter, said as a guess."""
    day = fields.get("issuedOn")
    if day and start <= day <= end:
        return day, False
    inside = next((d for d in fields.get("dates", []) if start <= d <= end), None)
    return (inside, False) if inside else (start, True)


def own_tax_id(connection: sqlite3.Connection, folder_id: int) -> str | None:
    """The holder's tax id: on an issued invoice the issuer is always the holder, so it is the one most of the
    folder's issued invoices (of every quarter) carry."""
    issued = [json.loads(r["fields"]).get("taxIds", []) for r in connection.execute(
        "SELECT fields FROM fiscal_file WHERE folder_id = ? AND path LIKE ?", (folder_id, f"{ISSUED}/%"))]
    issued = [list(dict.fromkeys(ids)) for ids in issued if ids]
    counts = Counter(t for ids in issued for t in ids)
    if not counts:
        return None
    # Most common first; on a tie, the one written earlier (the issuer heads an invoice).
    position = {t: sum(ids.index(t) for ids in issued if t in ids) / counts[t] for t in counts}
    tax_id = min(counts, key=lambda t: (-counts[t], position[t], t))
    return tax_id if counts[tax_id] >= max(1, round(len(issued) * 0.6)) else None


def scan(connection: sqlite3.Connection, folder_id: int, root: Path, year: int, quarter: int, start: str, end: str,
         known: set[str], known_files: set[str] | None = None) -> tuple[list[dict], list[dict], list[Path], dict]:
    """(issued rows, received rows, files still to read, counts) for that quarter. `known` are paths and
    `known_files` the sha256 of documents already in the register, which are not counted twice; the same
    file saved twice in the folder counts once. Only what was already read is used; the rest is returned to
    be read in the background."""
    unplaced: list[Path] = []
    issued = list(_files(root, ISSUED, year, quarter, unplaced))
    received = [(p, r) for p, r in _files(root, RECEIVED, year, quarter, unplaced) if str(p.relative_to(root)) not in known]
    pending, read = [], {}
    for path, _ in issued + received:
        fields = _cached(connection, folder_id, root, path)
        if fields is None:
            pending.append(path)
        else:
            read[path] = fields
    own = own_tax_id(connection, folder_id)
    seen = set(known_files or ())
    counts = {"unreadable": 0, "duplicates": 0, "unplaced": len(unplaced), "noVat": 0}

    def other(fields: dict) -> str | None:
        return next((t for t in fields.get("taxIds", []) if t and t != own), None)

    def fresh(fields: dict) -> bool:
        digest = fields.get("sha256")
        if digest and digest in seen:
            counts["duplicates"] += 1
            return False
        if digest:
            seen.add(digest)
        if fields.get("unreadable"):
            counts["unreadable"] += 1
            return False
        return True
    income, expenses = [], []
    for path, rest in issued:
        if path not in read or not fresh(read[path]):
            continue
        fields = read[path]
        day, guessed = _day(fields, start, end)
        base, total = fields.get("base"), fields.get("total")
        vat_rate, irpf_rate = fields.get("vatRate"), fields.get("withholdingRate") or 0.0
        if base is None and total is not None and vat_rate is not None:  # total = base + VAT − withholding
            base = str(round(float(total) / (1 + vat_rate - irpf_rate), 2))
        if vat_rate is None:
            counts["noVat"] += 1
        client_tax = other(fields)
        # The customer is named after the holder's block; never the holder (the file name often carries the holder's name).
        client = (fields.get("after") or {}).get(own) if own else None
        if not client and client_tax:
            client = (fields.get("after") or {}).get(client_tax)
        income.append({"date": day, "number": fields.get("number") or path.stem[:30], "client": client or _name(path, rest), "taxId": client_tax or "",
                       "concept": str(path.relative_to(root)), "base": float(base) if base is not None else None,
                       "vatRate": vat_rate or 0.0, "withholdingRate": irpf_rate, "total": total, "currency": fields.get("currency") or "EUR",
                       "guessedDate": guessed, "file": str(path.relative_to(root))})
    for path, rest in received:
        if path not in read or not fresh(read[path]):
            continue
        fields, relative = read[path], str(path.relative_to(root))
        day, guessed = _day(fields, start, end)
        notes = [n for n, on in (("Factura en imagen: revisa los importes", fields.get("image")),
                                 ("Fecha no leída: puesta al inicio del trimestre", guessed),
                                 ("Sin IVA desglosado", not fields.get("image") and fields.get("vat") is None)) if on]
        supplier_tax = other(fields)
        base, vat, total = fields.get("base"), fields.get("vat"), fields.get("total")
        if base is None and total and fields.get("vatRate") is not None:  # amounts in a column apart from their labels
            base = f"{float(total) / (1 + fields['vatRate']):.2f}"
            vat = f"{float(total) - float(base):.2f}"
            notes = [n for n in notes if n != "Sin IVA desglosado"]
        supplier = rest[-1] if rest else (fields.get("before") or {}).get(supplier_tax) or _name(path, rest)
        expenses.append({"id": f"archivo:{relative}", "doubts": notes, "issuedOn": day, "supplier": supplier, "taxId": supplier_tax,
                         "number": fields.get("number") or "", "concept": relative, "base": base, "vat": vat,
                         "total": fields.get("total") or "0", "currency": fields.get("currency") or "EUR", "notes": "; ".join(notes), "file": relative})
    return income, expenses, pending, counts
