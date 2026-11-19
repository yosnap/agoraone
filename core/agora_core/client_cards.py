"""The vault's client cards without a client: notes in a top folder «Clientes» of a vault («Clientes/<Nombre>.md», or
any note in «Clientes/<Nombre>/») whose name is no client of the directory, by name or alias regardless of case and
spaces. Only the names the brain's index already has (folder and file name, as the backend sent them) are looked at:
never a note's text, never the vault itself, and nothing is written, moved nor renamed there.

Each card has the strictest level of its notes. Discreet mode and Watson only get the normal ones; the others are
counted (`hidden`), never named."""

import sqlite3
import unicodedata

from .clients import same_name
from .index import LEVELS, normal_folder, strictest

FOLDER = "clientes"
MAX_CARDS = 200
NAME = 200


def _stem(ref: str) -> str:
    base = ref.replace("\\", "/").rsplit("/", 1)[-1]
    return base[:-3] if base.lower().endswith(".md") else base


def vault_cards(connection: sqlite3.Connection, entries: list[dict], discreet: bool) -> dict:
    """`{cards: [{name, level, notes}], count, hidden}`: `count` is every card without a client, `cards` the ones that
    may be shown (only normal ones in discreet mode), at most MAX_CARDS."""
    known = {same_name(name) for e in entries for name in (e["name"], *e.get("aliases", []))}
    found: dict[str, dict] = {}
    rows = connection.execute("SELECT ref, folder, confidentiality FROM item WHERE class = 'note' AND source LIKE 'vault-%'")
    for row in rows:
        parts = [part for part in str(row["folder"] or "").replace("\\", "/").split("/") if part.strip()]
        if not parts or normal_folder(parts[0]) != FOLDER:
            continue
        raw = parts[1] if len(parts) > 1 else _stem(str(row["ref"] or ""))
        name = " ".join(unicodedata.normalize("NFC", raw).split())[:NAME]
        key = same_name(name)
        if not key or key in known:
            continue
        level = row["confidentiality"] if row["confidentiality"] in LEVELS else "private"
        card = found.setdefault(key, {"name": name, "level": level, "notes": 0})
        card["level"], card["notes"] = strictest(card["level"], level), card["notes"] + 1
    cards = sorted(found.values(), key=lambda c: c["name"].casefold())
    shown = [c for c in cards if not discreet or c["level"] == "normal"]
    return {"cards": shown[:MAX_CARDS], "count": len(cards), "hidden": len(cards) - len(shown)}
