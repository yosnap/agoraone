"""Tidying the fiscal folder into one structure: `<Facturas Entrantes|Facturas Salientes>/<year>/<N>T/`.

The plan is worked out from folder names only (a month and a year, or «N trimestre» inside a year); what
cannot be told for sure is left where it is and listed as undecided. Applying it needs the user's
confirmation of the exact moves: every file is first copied to AgoraOne's own data, then moved without
overwriting anything. Nothing is deleted, not even folders left empty."""

import re
import shutil
from datetime import UTC, datetime
from pathlib import Path

from .fiscal import ISSUED, RECEIVED, FiscalError, _free, inside

MONTHS = {"enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6, "julio": 7, "agosto": 8,
          "septiembre": 9, "setiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12}
_YEAR = re.compile(r"(?<!\d)(20\d\d)(?!\d)")
_QUARTER = re.compile(r"(?<!\d)([1-4])\s*(?:t\b|trimestre)", re.I)
SKIP = {".DS_Store", "Icon\r"}
MAX_MOVES = 2000


def _where(parts: list[str]) -> tuple[int | None, int | None, int]:
    """Year, quarter and how many leading folders told them."""
    year = quarter = None
    used = 0
    for index, part in enumerate(parts):
        lower = part.casefold()
        found_year = _YEAR.search(part)
        month = next((n for name, n in MONTHS.items() if name in lower), None)
        found_quarter = _QUARTER.search(part)
        if found_year:
            year, used = int(found_year[1]), index + 1
        if month:
            quarter, used = (month - 1) // 3 + 1, index + 1
        elif found_quarter:
            quarter, used = int(found_quarter[1]), index + 1
    return year, quarter, used


def plan(root: Path) -> dict:
    """The moves that would bring the invoices into the structure, and what is left undecided."""
    moves, undecided = [], []
    for top in (RECEIVED, ISSUED):
        base = root / top
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.is_symlink() or path.name in SKIP or path.name.startswith("."):
                continue
            relative = path.relative_to(base)
            folders = list(relative.parts[:-1])
            if len(folders) >= 2 and re.fullmatch(r"20\d\d", folders[0]) and re.fullmatch(r"[1-4]T", folders[1]):
                continue  # already in place
            year, quarter, used = _where(folders)
            source = f"{top}/{relative}"
            if year is None or quarter is None:
                undecided.append(source)
                continue
            rest = "/".join(folders[used:] + [relative.name])
            moves.append({"from": source, "to": f"{top}/{year}/{quarter}T/{rest}"})
    return {"moves": moves[:MAX_MOVES], "undecided": undecided, "more": max(0, len(moves) - MAX_MOVES)}


def apply(root: Path, backups: Path, chosen: list[str]) -> dict:
    """Moves the confirmed files (by their current path), as the plan says now; a copy of each goes first
    to `backups`. Returns what was moved and the backup folder."""
    wanted = set(chosen)
    moves = [m for m in plan(root)["moves"] if m["from"] in wanted]
    if not moves:
        raise FiscalError("No hay movimientos que aplicar (puede que la carpeta haya cambiado: vuelve a calcular el plan).")
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    copy_root = backups / f"carpeta-fiscal-{stamp}"
    done = []
    for move in moves:
        source, target = inside(root, move["from"]), inside(root, move["to"])
        backup = copy_root / move["from"]
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, backup)
        target.parent.mkdir(parents=True, exist_ok=True)
        target = _free(target)
        inside(root, str(target.relative_to(root)))
        source.rename(target)
        done.append({"from": move["from"], "to": str(target.relative_to(root))})
    return {"moved": done, "backup": copy_root.name}
