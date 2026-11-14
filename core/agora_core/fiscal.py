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
import threading
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .db import now

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


KINDS = ("autonomo", "empresa", "personal")
CATEGORIES = ("gastos", "compras")


def _folder_row(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "name": row["name"], "kind": row["kind"], "path": row["path"], "scopeId": row["scope_id"], "holder": row["holder"]}


def folders(connection: sqlite3.Connection) -> list[dict]:
    return [_folder_row(r) for r in connection.execute("SELECT * FROM fiscal_folder ORDER BY id")]


def folder_root(connection: sqlite3.Connection, folder_id: int) -> tuple[dict, Path]:
    """A registered folder and its checked path (it may have been moved or deleted since)."""
    row = connection.execute("SELECT * FROM fiscal_folder WHERE id = ?", (folder_id,)).fetchone()
    if row is None:
        raise FiscalError("Esa carpeta fiscal no existe.")
    return _folder_row(row), check_folder(row["path"])


def add_folder(connection: sqlite3.Connection, name: str, kind: str, path: str, scope_id: int | None) -> int:
    if kind not in KINDS:
        raise FiscalError("Tipo de carpeta desconocido.")
    chosen = check_folder(path)
    name = re.sub(r"\s+", " ", name or "").strip()
    if not 1 <= len(name) <= 80:
        raise FiscalError("Ponle un nombre a la carpeta.")
    for other in connection.execute("SELECT name, path FROM fiscal_folder"):
        known = Path(other["path"])
        if other["name"].casefold() == name.casefold():
            raise FiscalError("Ya hay una carpeta fiscal con ese nombre.")
        if known == chosen or known in chosen.parents or chosen in known.parents:
            raise FiscalError(f"Esa carpeta coincide con «{other['name']}» o está dentro de ella.")
    if scope_id is not None and not connection.execute("SELECT 1 FROM scope WHERE id = ?", (scope_id,)).fetchone():
        raise FiscalError("Ese ámbito no existe.")
    return connection.execute("INSERT INTO fiscal_folder (name, kind, path, scope_id, created_at) VALUES (?, ?, ?, ?, ?)",
                              (name, kind, str(chosen), scope_id, now())).lastrowid


def change_folder(connection: sqlite3.Connection, folder_id: int, changes: dict) -> bool:
    values = {}
    if "name" in changes:
        name = re.sub(r"\s+", " ", changes["name"] or "").strip()
        if not 1 <= len(name) <= 80:
            raise FiscalError("Ponle un nombre a la carpeta.")
        values["name"] = name
    if "kind" in changes:
        if changes["kind"] not in KINDS:
            raise FiscalError("Tipo de carpeta desconocido.")
        values["kind"] = changes["kind"]
    if "scopeId" in changes:
        values["scope_id"] = changes["scopeId"]
    if "holder" in changes:
        values["holder"] = (changes["holder"] or "").strip()[:120] or None
    if not values:
        return bool(connection.execute("SELECT 1 FROM fiscal_folder WHERE id = ?", (folder_id,)).fetchone())
    try:
        return connection.execute(f"UPDATE fiscal_folder SET {', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
                                  [*values.values(), folder_id]).rowcount > 0
    except sqlite3.IntegrityError as error:
        raise FiscalError("Ya hay una carpeta fiscal con ese nombre o ese ámbito no existe.") from error


def remove_folder(connection: sqlite3.Connection, folder_id: int) -> bool:
    """Forgets the folder in AgoraOne; nothing in it is touched."""
    return connection.execute("DELETE FROM fiscal_folder WHERE id = ?", (folder_id,)).rowcount > 0


def suggested_folder(connection: sqlite3.Connection, message_id: int | None) -> int | None:
    """The folder for a message: the one of its rule's scope, else of its account's scope. Only a message
    with no scope at all falls back to the only professional folder; a scope without a folder gets none, so
    nothing personal is ever proposed for a professional folder (or the other way round)."""
    scopes: list[int] = []
    if message_id is not None:
        row = connection.execute(
            """SELECT r.scope_id AS rule_scope, a.scope_id AS account_scope FROM mail_message m JOIN mail_account a ON a.id = m.account_id
               LEFT JOIN mail_summary s ON s.message_id = m.id LEFT JOIN mail_rule r ON r.id = s.rule_id WHERE m.id = ?""",
            (message_id,)).fetchone()
        if row:
            scopes = [s for s in (row["rule_scope"], row["account_scope"]) if s is not None]
    for scope in scopes:
        found = connection.execute("SELECT id FROM fiscal_folder WHERE scope_id = ? ORDER BY id LIMIT 1", (scope,)).fetchone()
        if found:
            return found["id"]
    if scopes:
        return None
    ids = [r["id"] for r in connection.execute("SELECT id FROM fiscal_folder WHERE kind != 'personal'")]
    return ids[0] if len(ids) == 1 else None


_CHOOSING = threading.Lock()


def choose_with_finder(runner=None) -> str | None:
    """Opens the macOS folder chooser and returns the chosen path (None if cancelled)."""
    import subprocess

    run = runner or subprocess.run
    script = 'POSIX path of (choose folder with prompt "Elige la carpeta fiscal")'
    if not _CHOOSING.acquire(blocking=False):
        raise FiscalError("Ya hay un selector de carpetas abierto.")
    try:
        # Below the server's wait for the core, so a slow choice never comes back as «core unavailable».
        done = run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True, timeout=110)
    except (OSError, subprocess.TimeoutExpired):
        return None
    finally:
        _CHOOSING.release()
    path = (done.stdout or "").strip()
    return path.rstrip("/") or None if done.returncode == 0 else None


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


def destination(supplier: str, issued_on: str, total: str, kind: str = "autonomo", category: str | None = None, suffix: str = ".pdf") -> str:
    """Where a new document goes, relative to its folder: by quarter in professional folders, by year (and
    gastos or compras) in personal ones."""
    year, quarter = quarter_of(issued_on)
    name = f"{issued_on} {_safe_name(supplier)} {total.replace('.', ',')}{suffix}"
    if kind == "personal":
        return f"{'Compras' if category == 'compras' else 'Gastos'}/{year}/{name}"
    return f"{RECEIVED}/{year}/{quarter}T/{name}"


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


SUFFIXES = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic"}


def media_type(data: bytes) -> str | None:
    """What a file really is, from its first bytes (never from its name)."""
    if data.startswith(b"%PDF-"):
        return "application/pdf" if b"%%EOF" in data[-2048:] else None
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1", b"ftyphevc"):
        return "image/heic"
    return None


def file_invoice(connection: sqlite3.Connection, folder: dict, root: Path, data: bytes, fields: dict, message_id: int | None,
                 doubts: list[str], category: str | None = None, receipt_id: int | None = None) -> dict:
    """Writes the document in its folder (never over another file) and records it, once per message and once
    per file."""
    kind = media_type(data)
    if kind is None or len(data) > MAX_FILE:
        raise FiscalError("El archivo no es un PDF completo ni una foto, o es demasiado grande.")
    if folder["kind"] == "personal":
        if category not in CATEGORIES:
            raise FiscalError("Elige si es un gasto o una compra.")
    else:
        category = None
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
    taken = {row["path"] for row in connection.execute("SELECT path FROM invoice WHERE folder_id = ?", (folder["id"],))}
    target = _free(inside(root, destination(supplier, issued_on, total, folder["kind"], category, SUFFIXES[kind])), taken, root)
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
            """INSERT INTO invoice (folder_id, category, receipt_id, direction, message_id, supplier, tax_id, issued_on, base, vat, total,
                                    currency, notes, doubts, quarter, path, sha256, filed_at)
               VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (folder["id"], category, receipt_id, message_id, supplier[:120], tax_id, issued_on, amount(fields.get("base")), amount(fields.get("vat")), total, currency,
             (fields.get("notes") or None), json.dumps([d[:300] for d in doubts][:10], ensure_ascii=False), f"{year}-{quarter}T", relative,
             digest, now()),
        )
    except sqlite3.Error as error:
        target.unlink(missing_ok=True)  # the file we just wrote, nothing else
        raise FiscalError("No se pudo registrar la factura; no se ha guardado nada.") from error
    return {"id": cursor.lastrowid, "path": relative, "quarter": f"{year}-{quarter}T"}


def invoices(connection: sqlite3.Connection, quarter: str | None = None, folder_id: int | None = None) -> list[dict]:
    where, args = [], []
    if quarter:
        where.append("quarter = ?")
        args.append(quarter)
    if folder_id is not None:
        where.append("folder_id = ?")
        args.append(folder_id)
    rows = connection.execute(
        "SELECT * FROM invoice" + (f" WHERE {' AND '.join(where)}" if where else "") + " ORDER BY issued_on DESC, id DESC", args,
    ).fetchall()
    return [{"id": r["id"], "folderId": r["folder_id"], "category": r["category"], "direction": r["direction"], "messageId": r["message_id"], "supplier": r["supplier"], "taxId": r["tax_id"],
             "issuedOn": r["issued_on"], "base": r["base"], "vat": r["vat"], "total": r["total"], "currency": r["currency"],
             "notes": r["notes"], "doubts": json.loads(r["doubts"]), "quarter": r["quarter"], "path": r["path"]} for r in rows]
