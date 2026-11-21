"""Tidying the fiscal folder into one structure: `<Facturas Entrantes|Facturas Salientes>/<year>/<N>T/`.

The plan is worked out from folder names only (a month and a year, or «N trimestre» inside a year); what
cannot be told for sure is left where it is and listed as undecided. Applying it needs the user's
confirmation of the exact moves: every file is first copied to AgoraOne's own data, then moved without
overwriting anything. Nothing is deleted, not even folders left empty."""

import re
import shutil
from datetime import UTC, datetime
from pathlib import Path

from .fiscal import (
    ISSUED,
    RECEIVED,
    FiscalError,
    _free,
    inside,
    is_link,
    move_exclusive,
)

MONTHS = {"enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6, "julio": 7, "agosto": 8,
          "septiembre": 9, "setiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12}
_MONTH = re.compile(r"(?<![^\W\d_])(" + "|".join(MONTHS) + r")(?![^\W\d_])", re.I)
_YEAR = re.compile(r"(?<!\d)(20\d\d)(?!\d)")
_QUARTER = re.compile(r"(?<!\d)([1-4])\s*(?:t(?![^\W\d_])|trimestre)", re.I)
SKIP = {".DS_Store", "Icon\r"}
MAX_MOVES = 2000


class Unclear(Exception):
    pass


def _date_of(part: str) -> tuple[int | None, int | None]:
    """Year and quarter a folder name tells (a whole-word month, «N trimestre», a plausible year); a name
    with two different months or quarters is unclear."""
    years = {int(y) for y in _YEAR.findall(part) if 2000 <= int(y) <= datetime.now(UTC).year + 1}
    months = {MONTHS[m.casefold()] for m in _MONTH.findall(part)}
    quarters = {(m - 1) // 3 + 1 for m in months} | {int(q) for q in _QUARTER.findall(part)}
    if len(years) > 1 or len(quarters) > 1:
        raise Unclear
    return (years.pop() if years else None), (quarters.pop() if quarters else None)


def _where(folders: list[str]) -> tuple[int | None, int | None, list[str]]:
    """Year, quarter and the folders that are not dates (kept below the quarter, e.g. a supplier's)."""
    year = quarter = None
    rest = []
    for part in folders:
        found_year, found_quarter = _date_of(part)
        if found_year is None and found_quarter is None:
            rest.append(part)
            continue
        if found_year is not None:
            if year not in (None, found_year):
                raise Unclear
            year = found_year
        if found_quarter is not None:
            if quarter not in (None, found_quarter):
                raise Unclear
            quarter = found_quarter
    return year, quarter, rest


def plan(root: Path) -> dict:
    """The moves that would bring the invoices into the structure, and what is left undecided."""
    moves, undecided = [], []
    for top in (RECEIVED, ISSUED):
        base = root / top
        if not base.is_dir() or is_link(base) or root not in base.resolve().parents:
            continue
        for path in sorted(base.rglob("*")):
            if is_link(path) or not path.is_file() or path.name in SKIP:
                continue
            relative = path.relative_to(base)
            if any(part.startswith(".") for part in relative.parts[:-1]):
                continue
            source = f"{top}/{relative.as_posix()}"
            if path.name.startswith("."):
                if path.name.endswith(".icloud"):  # still in iCloud, not downloaded to this Mac
                    undecided.append(source)
                continue
            folders = list(relative.parts[:-1])
            if len(folders) >= 2 and re.fullmatch(r"20\d\d", folders[0]) and re.fullmatch(r"[1-4]T", folders[1], re.I):
                continue  # already in place (APFS does not tell «1t» from «1T»)
            try:
                year, quarter, rest = _where(folders)
            except Unclear:
                year = quarter = None
            if year is None or quarter is None:
                undecided.append(source)
                continue
            moves.append({"from": source, "to": "/".join([top, str(year), f"{quarter}T", *rest, relative.name])})
    return {"moves": moves[:MAX_MOVES], "undecided": undecided, "more": max(0, len(moves) - MAX_MOVES)}


def apply(root: Path, backups: Path, chosen: list[dict], on_move=None) -> dict:
    """Moves the confirmed files, only where the user saw them going (pairs that still match the plan now).
    A copy of each goes first to `backups`; a move never replaces a file. A failure stops the rest and is
    reported with what was already done; `on_move(from, to)` runs after each move (to update the register)."""
    current = {(m["from"], m["to"]) for m in plan(root)["moves"]}
    moves = [m for m in chosen if (m.get("from"), m.get("to")) in current]
    if not moves:
        raise FiscalError("No hay movimientos que aplicar (puede que la carpeta haya cambiado: vuelve a calcular el plan).")
    pairs = [(inside(root, m["from"]), inside(root, m["to"])) for m in moves]  # every path checked before the first move
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    copy_root = backups / f"carpeta-fiscal-{stamp}"
    done, error = [], None
    for move, (source, target) in zip(moves, pairs):
        try:
            backup = copy_root / move["from"]
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, backup)
            target.parent.mkdir(parents=True, exist_ok=True)
            for _ in range(5):
                final = _free(target)
                inside(root, final.relative_to(root).as_posix())
                try:
                    move_exclusive(source, final)
                    break
                except FileExistsError:
                    continue  # a file with that name appeared meanwhile: try the next free name
            else:
                raise FiscalError("No se encontró un nombre libre.")
        except (OSError, FiscalError) as failure:
            error = f"Se detuvo en {move['from']}: {failure if isinstance(failure, FiscalError) else 'no se pudo mover'}."
            break
        done.append({"from": move["from"], "to": final.relative_to(root).as_posix()})
        if on_move:
            on_move(move["from"], done[-1]["to"])
    return {"moved": done, "backup": copy_root.name, "error": error}
