"""The vault's review (1.7): what makes it hard to find things, from the brain's index and without changing
anything. Notes loose in the root, orphans (no link in or out), repeated titles, nearly empty notes, folders
with a single note or far too many, folders too deep, and notes that hold something like a password (only
their title: the index already keeps those lines hidden, as «[credencial omitida]», and they never reach a
model). For the owner's screen; discreet mode counts only normal notes."""

import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict

CAP = 30
SECRET_MARKS = ("[credencial omitida]", "[contenido reservado]")
TINY = 80
CROWDED = 150
DEEP = 4


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", "".join(c for c in unicodedata.normalize("NFD", text.lower()) if unicodedata.category(c) != "Mn")).strip()


def review(connection: sqlite3.Connection, discreet: bool) -> dict:
    hidden = "AND confidentiality = 'normal'" if discreet else ""
    notes = connection.execute(f"SELECT id, source, ref, title, folder FROM item WHERE class = 'note' {hidden}").fetchall()
    by_id = {n["id"]: n for n in notes}
    key = lambda n: {"key": f"{n['source']}/{n['ref']}", "title": n["title"] or "Sin título", "folder": n["folder"] or ""}  # noqa: E731
    sizes: dict[int, int] = defaultdict(int)
    secret: set[int] = set()
    for row in connection.execute("SELECT item_id, text FROM chunk"):
        if row["item_id"] in by_id:
            sizes[row["item_id"]] += len(row["text"])
            if any(mark in row["text"] for mark in SECRET_MARKS):
                secret.add(row["item_id"])
    outgoing: dict[int, int] = Counter()
    targets: set[str] = set()
    for row in connection.execute("SELECT item_id, target FROM note_link"):
        if row["item_id"] in by_id:
            outgoing[row["item_id"]] += 1
            targets.add(_plain(row["target"].split("|")[0].split("#")[0].split("/")[-1]))
    titles = defaultdict(list)
    folders = Counter()
    for n in notes:
        titles[_plain(n["title"] or "")].append(n)
        folders[n["folder"] or ""] += 1
    orphans = [n for n in notes if not outgoing[n["id"]] and _plain(n["title"] or "") not in targets]
    duplicates = [{"title": group[0]["title"], "notes": [key(n) for n in group[:6]]} for t, group in titles.items() if t and len(group) > 1]
    duplicates.sort(key=lambda d: -len(d["notes"]))
    root = [n for n in notes if not (n["folder"] or "").strip("/")]
    tiny = [n for n in notes if sizes[n["id"]] < TINY]
    lonely = sorted(f for f, count in folders.items() if f and count == 1)
    crowded = sorted(((f, c) for f, c in folders.items() if c > CROWDED), key=lambda fc: -fc[1])
    deep = sorted(f for f in folders if f.count("/") + 1 > DEEP)
    found = {
        "root": [key(n) for n in root[:CAP]], "rootCount": len(root),
        "orphans": [key(n) for n in orphans[:CAP]], "orphanCount": len(orphans),
        "duplicates": duplicates[:CAP], "duplicateCount": len(duplicates),
        "tiny": [key(n) for n in tiny[:CAP]], "tinyCount": len(tiny),
        "lonelyFolders": lonely[:CAP], "lonelyCount": len(lonely),
        "crowdedFolders": [{"folder": f or "(raíz)", "notes": c} for f, c in crowded[:CAP]],
        "deepFolders": deep[:CAP], "deepCount": len(deep),
        "secrets": [key(by_id[i]) for i in sorted(secret)[:CAP]], "secretCount": len(secret),
    }
    found["notes"], found["folders"] = len(notes), len(folders)
    return found
