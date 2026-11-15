"""What the brain's home shows at its side, for the owner's screen only (never sent to a model): the areas
(the vault's top-level folders, with how many notes, how many subfolders, when they last changed and a
one-line description taken from the area's own index note when it has one) and «Últimamente», what changed
today and yesterday (notes and meetings). Discreet mode leaves out everything that is not normal."""

import re
import sqlite3
from datetime import UTC, datetime, timedelta

INDEX_TITLES = {"readme", "índice", "indice", "index", "_index", "inicio", "home"}
MAX_DESCRIPTION = 160
LATELY_PER_DAY = 12


def _area(folder: str) -> str:
    return (folder or "").split("/")[0].strip()


def _description(text: str) -> str | None:
    """The first sentence of real prose: no properties, headings, lists of links or tables."""
    text = re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "|", "---", "![", "[[", "- [[", ">", "```")) or len(line) < 25:
            continue
        line = re.sub(r"\[\[([^\]|]+)(\|([^\]]+))?\]\]", lambda m: m.group(3) or m.group(1), line)
        line = re.sub(r"[*_`]", "", line)
        sentence = re.split(r"(?<=[.!?])\s", line)[0]
        return sentence if len(sentence) <= MAX_DESCRIPTION else sentence[:MAX_DESCRIPTION - 1].rstrip() + "…"
    return None


def areas(connection: sqlite3.Connection, discreet: bool) -> list[dict]:
    hidden = "AND confidentiality = 'normal'" if discreet else ""
    found: dict[str, dict] = {}
    for row in connection.execute(f"SELECT id, title, folder, modified_at FROM item WHERE class = 'note' {hidden}"):
        name = _area(row["folder"])
        area = found.setdefault(name, {"name": name, "notes": 0, "subfolders": {}, "changed": "", "index": None})
        area["notes"] += 1
        rest = row["folder"][len(name):].strip("/")
        if rest:
            sub = rest.split("/")[0]
            area["subfolders"][sub] = area["subfolders"].get(sub, 0) + 1
        area["changed"] = max(area["changed"], row["modified_at"] or "")
        title = (row["title"] or "").strip().lower()
        if row["folder"].strip("/") == name and (title in INDEX_TITLES or title == name.lower()):
            area["index"] = row["id"]
    result = []
    for area in found.values():
        description = None
        if area["index"]:
            first = connection.execute("SELECT text FROM chunk WHERE item_id = ? ORDER BY ord LIMIT 1", (area["index"],)).fetchone()
            description = _description(first["text"]) if first else None
        written = description is not None
        if not written and area["subfolders"]:
            # Without an index note, what the area holds: its biggest subfolders, which is real data.
            biggest = sorted(area["subfolders"], key=lambda s: (-area["subfolders"][s], s))[:3]
            description = "Incluye " + ", ".join(biggest[:-1]) + (" y " if len(biggest) > 1 else "") + biggest[-1] + ("…" if len(area["subfolders"]) > 3 else "")
        result.append({"name": area["name"], "notes": area["notes"], "subfolders": len(area["subfolders"]),
                       "changed": area["changed"] or None, "description": description, "written": written})
    return sorted(result, key=lambda a: (-a["notes"], a["name"]))


def lately(connection: sqlite3.Connection, discreet: bool, now: datetime | None = None) -> dict:
    """Today's and yesterday's changes, local time: notes changed and meetings recorded."""
    now = (now or datetime.now(UTC)).astimezone()
    days = {"today": now.date(), "yesterday": (now - timedelta(days=1)).date()}
    since = datetime.combine(days["yesterday"], datetime.min.time(), now.tzinfo).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
    hidden = "AND confidentiality = 'normal'" if discreet else ""
    entries: list[dict] = []
    for row in connection.execute(f"""SELECT id, source, ref, title, folder, modified_at FROM item WHERE class = 'note' AND modified_at >= ? {hidden}
                                      ORDER BY modified_at DESC LIMIT 200""", (since,)):
        entries.append({"kind": "nota", "text": row["title"] or "Nota sin título", "detail": row["folder"] or None, "when": row["modified_at"], "id": row["id"], "key": f"{row['source']}/{row['ref']}"})
    for row in connection.execute(f"""SELECT id, title, status, work, started_at FROM meeting WHERE started_at >= ? {hidden}
                                      ORDER BY started_at DESC LIMIT 50""", (since,)):
        state = "resumida" if row["work"] == "done" else "grabada" if row["status"] == "recorded" else "interrumpida" if row["status"] == "interrupted" else "grabando"
        entries.append({"kind": "reunión", "text": row["title"], "detail": state, "when": row["started_at"], "id": row["id"]})
    out = {"today": [], "yesterday": []}
    for entry in sorted(entries, key=lambda e: e["when"], reverse=True):
        stamp = datetime.fromisoformat(entry["when"].replace("Z", "+00:00")).astimezone()
        key = "today" if stamp.date() == days["today"] else "yesterday" if stamp.date() == days["yesterday"] else None
        if key and len(out[key]) < LATELY_PER_DAY:
            out[key].append(entry)
    return out
