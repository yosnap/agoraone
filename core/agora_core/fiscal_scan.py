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
_STARTED: dict[int, int] = {}  # how many files the current reading of each folder started with (for the progress bar)
_MODEL_FAILURES: dict[tuple[int, str], int] = {}  # failed model calls per file (network, rate limit, no session)
MAX_MODEL_FAILURES = 3


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
    return fields if fields.get("v") == invoice_extract.VERSION or fields.get("tooBig") else None


def read_in_background(database, folder_id: int, root: Path, paths: list[Path], ask=None) -> None:
    """Reads the PDFs not read yet, four at a time, without holding up the request that found them; then, if
    `ask(texts)` is given (Claude Haiku), reads their data with it, five invoices per call."""
    with _READING_LOCK:
        todo = [p for p in paths if (folder_id, str(p)) not in _READING]
        if not any(f == folder_id for f, _ in _READING):
            _STARTED[folder_id] = 0
        _STARTED[folder_id] = _STARTED.get(folder_id, 0) + len(todo)
        _READING.update((folder_id, str(p)) for p in todo)
    if not todo:
        return

    def one(path: Path) -> None:
        try:
            with database() as connection:
                try:
                    _read(connection, folder_id, root, path)
                except Exception:  # noqa: BLE001 - kept as unreadable, so it is counted and never read in a loop
                    _remember(connection, folder_id, root, path, {"unreadable": True, "v": invoice_extract.VERSION})
        except Exception:  # noqa: BLE001
            pass

    def run() -> None:
        try:
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(one, todo))
            if ask is not None:
                _read_with_model(database, folder_id, root, todo, ask)
        finally:  # «still reading» until the model is done too
            _done(folder_id, todo)
    threading.Thread(target=run, daemon=True).start()


def _as_jpeg(path: Path) -> bytes | None:
    """The image as a JPEG of at most 1600 px (HEIC and PNG too), with macOS's own sips; None if it cannot."""
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as work:
        out = Path(work) / "factura.jpg"
        try:
            subprocess.run(["/usr/bin/sips", "-s", "format", "jpeg", "-Z", "1600", str(path), "--out", str(out)],
                           capture_output=True, timeout=30, check=True)
            data = out.read_bytes()
        except (OSError, subprocess.SubprocessError):
            return None
    return data if 0 < len(data) <= MAX_FILE else None


def _give_up(database, folder_id: int, root: Path, path: Path) -> None:
    """Marks the file as asked, so it keeps the local rules and is never queued again in a loop."""
    with database() as connection:
        fields = _cached(connection, folder_id, root, path) or {}
        if fields and not fields.get("unreadable"):
            _remember(connection, folder_id, root, path, {**fields, "aiTried": True})
    _MODEL_FAILURES.pop((folder_id, str(path)), None)


def _model_failed(database, folder_id: int, root: Path, path: Path) -> None:
    """A failed call may be passing (no network, rate limit): asked again on the next loads, up to a limit."""
    key = (folder_id, str(path))
    _MODEL_FAILURES[key] = _MODEL_FAILURES.get(key, 0) + 1
    if _MODEL_FAILURES[key] >= MAX_MODEL_FAILURES:
        _give_up(database, folder_id, root, path)


def _read_with_model(database, folder_id: int, root: Path, paths: list[Path], ask) -> None:
    """Adds what the model reads to what the local rules found (the model wins where it found something)."""
    texts: list[tuple[Path, str]] = []
    image = getattr(ask, "image", None)
    # The user may turn the model off while this runs: asked again before each call and before saving its answer.
    allowed = getattr(ask, "allowed", lambda: True)
    for path in paths:
        if not allowed():
            return
        with database() as connection:
            known = _cached(connection, folder_id, root, path) or {}
        if known.get("image") and image is not None:  # a photo or scanned invoice: Claude reads the image
            jpeg = _as_jpeg(path)
            if not jpeg:  # not convertible (damaged, protected, no sips): it will not change on its own
                _give_up(database, folder_id, root, path)
            else:
                try:
                    found = image(jpeg)
                except Exception:  # noqa: BLE001
                    _model_failed(database, folder_id, root, path)
                else:
                    if not allowed():
                        return
                    with database() as connection:
                        fields = _cached(connection, folder_id, root, path) or {}
                        _remember(connection, folder_id, root, path, {**fields, "ai": found} if found else {**fields, "aiTried": True})
                    _MODEL_FAILURES.pop((folder_id, str(path)), None)
            _done(folder_id, [path])
            continue
        if path.suffix.lower() == ".pdf" and not known.get("image"):
            try:
                text = invoice_extract.pdf_text(path.read_bytes())
            except OSError:
                text = ""
            if text.strip():
                texts.append((path, text))
            else:
                _give_up(database, folder_id, root, path)
    for i in range(0, len(texts), 5):
        batch = texts[i:i + 5]
        if not allowed():
            return
        try:
            found = ask([text for _, text in batch])
        except Exception:  # noqa: BLE001 - without the model, the local rules stay
            for path, _ in batch:
                _model_failed(database, folder_id, root, path)
            continue
        if not allowed():
            return
        for path, _ in batch:
            _MODEL_FAILURES.pop((folder_id, str(path)), None)
        with database() as connection:
            for n, (path, _) in enumerate(batch, 1):
                _done(folder_id, [path])
                fields = _cached(connection, folder_id, root, path) or {}
                if not fields.get("unreadable"):
                    # «aiTried»: asked once without an answer, so it is not asked again in a loop.
                    _remember(connection, folder_id, root, path, {**fields, "ai": found[n]} if found.get(n) else {**fields, "aiTried": True})


def _done(folder_id: int, paths) -> None:
    with _READING_LOCK:
        _READING.difference_update((folder_id, str(p)) for p in paths)


def progress(folder_id: int) -> tuple[int, int]:
    """(still reading, started with) for the folder's current reading."""
    with _READING_LOCK:
        left = sum(1 for f, _ in _READING if f == folder_id)
        return left, max(left, _STARTED.get(folder_id, left))


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
                # Scanned or rendered as a picture: Claude reads its first page as an image (or, without the
                # model, it stays unreadable until read).
                fields["image"] = fields["scanned"] = True
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
    if inside:
        return inside, False
    return (day, False) if day else (start, True)  # its own date, even if outside: it is in this quarter's folder


def _consistent(merged: dict, local_total) -> None:
    """A model can misread one figure: base + VAT − withholding must give the total. If not, the local rules'
    total wins when it adds up, else the sum of the parts."""
    try:
        base, vat = float(merged.get("base")), abs(float(merged.get("vat") or 0))
        # Withholding may come as «-162.45» or only as a rate.
        withholding = abs(float(merged["withholding"])) if merged.get("withholding") not in (None, "") else base * float(merged.get("withholdingRate") or 0)
        total = float(merged.get("total"))
    except (TypeError, ValueError):
        return
    parts = round(base + vat - withholding, 2)
    if abs(parts - total) > 0.02 and abs(round(base + vat, 2) - total) > 0.02:  # some receipts show the total before withholding
        merged["total"] = local_total if local_total and abs(float(local_total) - parts) <= 0.02 else f"{parts:.2f}"


def _merged(fields: dict, issued: bool, use_model: bool = True) -> dict:
    """What the model read, where it read something, over what the local rules found. The other party is the
    receiver on an issued invoice and the issuer on a received one. With the model off, only the local rules."""
    ai = fields.get("ai") if use_model else None
    if not ai:
        return fields
    merged = dict(fields)
    for key in ("number", "issuedOn", "base", "vatRate", "vat", "withholdingRate", "withholding", "total", "currency"):
        if ai.get(key) is not None:
            merged[key] = ai[key]
    name, tax_id = (ai.get("receiver"), ai.get("receiverTaxId")) if issued else (ai.get("issuer"), ai.get("issuerTaxId"))
    if tax_id:
        merged["taxIds"] = [tax_id]
    merged["otherName"], merged["otherTaxId"] = name, tax_id
    if merged.get("base") is None and merged.get("total") and float(merged.get("vat") or 0) == 0:
        merged["base"], merged["vat"] = merged["total"], "0.00"  # a receipt without VAT, as the user's register records it
    _consistent(merged, fields.get("total"))
    return merged


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
         known: set[str], known_files: set[str] | None = None, use_model: bool = True) -> tuple[list[dict], list[dict], list[Path], dict]:
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
    seen: dict[str, str | None] = dict.fromkeys(known_files or ())  # sha256 → first copy seen (None: already filed)
    rel = lambda p: str(p.relative_to(root))  # noqa: E731
    counts = {"unreadable": [], "duplicates": [], "duplicateOf": {}, "unplaced": [rel(p) for p in unplaced], "noVat": [],
              # read by the local rules but not yet by the model (the app closed mid-way, or the model was off)
              "modelPending": [p for p, f in read.items() if not f.get("ai") and not f.get("aiTried") and not f.get("unreadable")]}

    def other(fields: dict) -> str | None:
        if fields.get("otherTaxId"):
            return fields["otherTaxId"]
        return next((t for t in fields.get("taxIds", []) if t and t != own), None)

    def fresh(path: Path, fields: dict) -> bool:
        digest = fields.get("sha256")
        if digest and digest in seen:
            counts["duplicates"].append(rel(path))
            counts["duplicateOf"][rel(path)] = seen[digest]
            return False
        if digest:
            seen[digest] = rel(path)
        if fields.get("unreadable"):
            counts["unreadable"].append(rel(path))
            return False
        return True
    income, expenses = [], []
    for path, rest in issued:
        if path not in read or not fresh(path, read[path]):
            continue
        fields = _merged(read[path], issued=True, use_model=use_model)
        day, guessed = _day(fields, start, end)
        base, total = fields.get("base"), fields.get("total")
        vat_rate, irpf_rate = fields.get("vatRate"), fields.get("withholdingRate") or 0.0
        if base is None and total is not None and vat_rate is not None:  # total = base + VAT − withholding
            base = str(round(float(total) / (1 + vat_rate - irpf_rate), 2))
        if vat_rate is None:
            counts["noVat"].append(rel(path))
        client_tax = other(fields)
        # The customer is named after the holder's block; never the holder (the file name often carries the holder's name).
        client = fields.get("otherName") or ((fields.get("after") or {}).get(own) if own else None)
        if not client and client_tax:
            client = (fields.get("after") or {}).get(client_tax)
        income.append({"date": day, "number": fields.get("number") or path.stem[:30], "client": client or _name(path, rest), "taxId": client_tax or "",
                       "concept": str(path.relative_to(root)), "base": float(base) if base is not None else None,
                       "vatRate": vat_rate or 0.0, "withholdingRate": irpf_rate, "total": total, "currency": fields.get("currency") or "EUR",
                       "guessedDate": guessed, "file": str(path.relative_to(root))})
    for path, rest in received:
        if path not in read or not fresh(path, read[path]):
            continue
        fields, relative = _merged(read[path], issued=False, use_model=use_model), str(path.relative_to(root))
        day, guessed = _day(fields, start, end)
        notes = [n for n, on in (("Factura en imagen: revisa los importes", fields.get("image") and not fields.get("ai")),
                                 ("Su fecha es de otro trimestre: está en la carpeta de este", day < start or day > end),
                                 ("Fecha no leída: puesta al inicio del trimestre", guessed),
                                 ("Sin IVA desglosado", fields.get("vat") is None and (fields.get("ai") or not fields.get("image"))),
                                 ("Leída solo con reglas locales: compruébala", not fields.get("ai") and not fields.get("image")),
                                 ("Leída de una imagen por Claude: compruébala", fields.get("image") and fields.get("ai"))) if on]
        supplier_tax = other(fields)
        base, vat, total = fields.get("base"), fields.get("vat"), fields.get("total")
        if base is None and total and fields.get("vatRate") is not None and not fields.get("ai"):  # amounts in a column apart from their labels
            base = f"{float(total) / (1 + fields['vatRate']):.2f}"
            vat = f"{float(total) - float(base):.2f}"
            notes = [n for n in notes if n != "Sin IVA desglosado"]
        elif base is not None and vat is None and total and fields.get("ai") and abs(float(base) - float(total)) < 0.01:
            vat = "0.00"  # base equal to the total: no VAT
        elif base is None and vat is None and total and fields.get("ai"):
            # A receipt without VAT shown (as the user's register records it): base = total, VAT 0, said in the notes.
            base, vat = total, "0.00"
        web = fields.get("web")
        supplier = (fields.get("otherName") or (rest[-1] if rest else None) or (fields.get("before") or {}).get(supplier_tax)
                    or (web.capitalize() if web else None) or _name(path, rest))
        expenses.append({"id": f"archivo:{relative}", "doubts": notes, "issuedOn": day, "supplier": supplier, "taxId": supplier_tax,
                         "number": fields.get("number") or "", "concept": relative, "base": base, "vat": vat,
                         "total": fields.get("total") or "0", "currency": fields.get("currency") or "EUR", "notes": "; ".join(notes), "file": relative})
    return income, expenses, pending, counts
