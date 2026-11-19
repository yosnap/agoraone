"""The vault's reorganisation (1.7): what Watson may see to propose an order, and the check of the batch of
moves and renames it proposes. Nothing is moved here: the screen shows every change with its box and only the
ones the user leaves ticked go through the vault's own move route (confirmation, copy first, revision check,
never overwriting and never deleting). Only `normal` notes take part: a `local_only` or `private` note never
reaches a model, so it can never be named in a proposal."""

import re
import sqlite3
import unicodedata

from . import vault_review

MAX_CHANGES = 40
MAX_FOLDERS = 200
BAD_TITLE = re.compile(r'[/\\:*?"<>|#^\[\]\x00-\x1f\x7f]')
BAD_FOLDER = re.compile(r'[\\:*?"<>|#^\[\]\x00-\x1f\x7f]')
INVISIBLE = re.compile(r"[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]")


class ReorgError(ValueError):
    pass


def _plain(text: str) -> str:
    return vault_review._plain(text)


def outline(connection: sqlite3.Connection) -> dict:
    """The vault as Watson may see it: folders with how many normal notes each holds, and the review's findings,
    only over normal notes (the review's discreet mode). No text of any note, no notes with hidden keys."""
    found = vault_review.review(connection, True)
    folders = connection.execute(
        """SELECT folder, COUNT(*) AS notes FROM item WHERE class = 'note' AND confidentiality = 'normal'
           GROUP BY folder ORDER BY folder"""
    ).fetchall()
    found.pop("secrets", None)
    found.pop("secretCount", None)
    found["folderList"] = [{"folder": row["folder"] or "", "notes": row["notes"]} for row in folders[:MAX_FOLDERS]]
    return found


def _folder(raw: str) -> str:
    folder = "/".join(part.strip() for part in str(raw or "").strip().strip("/").split("/"))
    if not folder:
        return ""
    parts = folder.split("/")
    if len(folder) > 1000 or BAD_FOLDER.search(folder) or INVISIBLE.search(folder) or any(not p or p.startswith(".") or len(p) > 120 for p in parts):
        raise ReorgError("carpeta no válida")
    return unicodedata.normalize("NFC", folder)


def _title(raw: str) -> str:
    title = unicodedata.normalize("NFC", str(raw or "").strip())
    if not title or title.startswith(".") or BAD_TITLE.search(title) or INVISIBLE.search(title) or len(title.encode()) + 3 > 255:
        raise ReorgError("título no válido (sin / \\ : * ? \" < > | # ^ [ ] ni punto inicial)")
    return title


def check(connection: sqlite3.Connection, notes: dict[int, dict], changes: list) -> tuple[list[dict], list[dict]]:
    """Checks the moves Watson proposes. `notes` are the ones it was shown, by their number (n): it can never name
    another. Returns the valid moves (with the note's source and ref for the vault's route) and the rejected
    ones with why, so it can correct them. A destination must be an existing folder, the top level, or a new
    folder one level inside an existing one (the vault's own rule when creating)."""
    if not isinstance(changes, list) or not changes:
        raise ReorgError("Propón al menos un cambio.")
    if len(changes) > MAX_CHANGES:
        raise ReorgError(f"Como mucho {MAX_CHANGES} cambios por lote: propón el resto después.")
    rows = connection.execute(
        "SELECT source, ref, title, folder FROM item WHERE class = 'note' AND confidentiality = 'normal'"
    ).fetchall()
    existing: set[str] = set()
    taken: dict[tuple[str, str, str], set[str]] = {}
    for row in rows:
        folder = row["folder"] or ""
        taken.setdefault((row["source"], _plain(folder), _plain(row["title"] or "")), set()).add(row["ref"])
        parts = folder.split("/") if folder else []
        existing.update("/".join(parts[:i]) for i in range(1, len(parts) + 1))
    links: dict[str, int] = {}
    paths: dict[str, int] = {}  # links that also name the folder, [[Carpeta/Nota]]: moving breaks them too
    for row in connection.execute("SELECT target FROM note_link"):
        link = row["target"].split("|")[0].split("#")[0]
        target = _plain(link.split("/")[-1])
        links[target] = links.get(target, 0) + 1
        if "/" in link:
            paths[target] = paths.get(target, 0) + 1
    moves, rejected, used, chosen = [], [], set(), set()
    for change in changes:
        change = change if isinstance(change, dict) else {}
        n = change.get("n")
        note = notes.get(int(n)) if isinstance(n, (int, float, str)) and str(n).strip().isdigit() else None
        if note is None:
            rejected.append({"n": n, "motivo": "no hay ninguna nota con ese número: búscala primero"})
            continue
        try:
            row = connection.execute(
                "SELECT title, folder FROM item WHERE class = 'note' AND confidentiality = 'normal' AND source = ? AND ref = ?",
                (note["source"], note["ref"]),
            ).fetchone()
            if row is None:
                raise ReorgError("esa nota ya no está en el vault")
            if (note["source"], note["ref"]) in used:
                raise ReorgError("esa nota ya tiene otro cambio en este lote")
            current_folder, current_title = row["folder"] or "", row["title"] or ""
            folder = _folder(change["carpeta"]) if "carpeta" in change and change["carpeta"] is not None else current_folder
            title = _title(change["titulo"]) if change.get("titulo") else current_title
            if folder == current_folder and title == current_title:
                raise ReorgError("ya tiene ese título y está en esa carpeta")
            parent = folder.rsplit("/", 1)[0] if "/" in folder else ""
            new_folder = bool(folder) and folder not in existing
            if new_folder and (not parent or parent not in existing):
                raise ReorgError("la carpeta no existe: usa una existente o una nueva dentro de una que exista (nunca en la raíz)")
            destination = (note["source"], _plain(folder), _plain(title))
            if (taken.get(destination, set()) - {note["ref"]}) or destination in chosen:
                raise ReorgError("ya hay una nota con ese título en esa carpeta")
        except ReorgError as error:
            rejected.append({"n": n, "motivo": str(error)})
            continue
        used.add((note["source"], note["ref"]))
        chosen.add(destination)
        renamed = _plain(title) != _plain(current_title)
        moves.append({
            "n": int(n), "source": note["source"], "ref": note["ref"], "title": current_title, "folder": current_folder,
            "toFolder": folder, "toTitle": title if title != current_title else None, "newFolder": new_folder,
            "links": links.get(_plain(current_title), 0) if renamed else paths.get(_plain(current_title), 0) if folder != current_folder else 0, "reason": str(change.get("motivo") or "")[:200],
        })
    return moves, rejected
