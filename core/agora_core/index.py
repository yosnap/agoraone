"""Index of notes sent by the backend: fragments, confidentiality and incremental changes.

The backend reads the vault with its proven rules and sends text whose credential-like lines are already
masked; the core never reads the vault itself.
"""

import re
import sqlite3
import unicodedata
from dataclasses import dataclass

from .db import now

LEVELS = ("normal", "local_only", "private")
CHUNK_CHARS = 1000
_FRONTMATTER = re.compile(r"\A\ufeff?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.S)
# Lenient on purpose: quoted keys, spaces, repeated keys. Every match counts and the strictest wins.
_DECLARED = re.compile(r"^\s*[\"']?(?:confidencialidad|confidentiality)[\"']?\s*:\s*[\"']?([^\"'\n#]*)", re.I | re.M)
_ALIASES = {
    "normal": "normal", "publico": "normal", "público": "normal",
    "solo-local": "local_only", "solo local": "local_only", "sololocal": "local_only", "local_only": "local_only",
    "local-only": "local_only", "local": "local_only",
    "privado": "private", "privada": "private", "private": "private",
}


@dataclass(frozen=True)
class Note:
    ref: str
    title: str
    folder: str
    revision: str
    modified_at: str
    text: str


def strictest(*levels: str) -> str:
    return max(levels, key=LEVELS.index)


def split_frontmatter(text: str) -> tuple[str, str]:
    match = _FRONTMATTER.match(text)
    return (match[1], text[match.end():]) if match else ("", text)


def declared_level(text: str) -> str:
    """The level a note declares in its properties: the strictest of every mention; a value that is not
    recognised counts as private, to be safe."""
    properties, _ = split_frontmatter(text)
    levels = [_ALIASES.get(value.strip().lower(), "private") for value in _DECLARED.findall(properties)]
    return strictest("normal", *levels)


def normal_folder(folder: str) -> str:
    """One spelling for a folder: NFC, case-folded, forward slashes, no empty, '.' or surrounding spaces."""
    parts = unicodedata.normalize("NFC", folder).replace("\\", "/").casefold().split("/")
    return "/".join(part.strip() for part in parts if part.strip() not in ("", "."))


def chunks(title: str, text: str) -> list[str]:
    """Fragments of about CHUNK_CHARS by paragraphs, starting anew at headings; each carries the title."""
    _, body = split_frontmatter(text)
    pieces, current = [], ""
    for paragraph in re.split(r"\n\s*\n", body):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        heading = paragraph.startswith("#")
        if current and (heading or len(current) + len(paragraph) > CHUNK_CHARS):
            pieces.append(current)
            current = ""
        while len(paragraph) > CHUNK_CHARS:
            cut = paragraph.rfind(" ", 0, CHUNK_CHARS)
            cut = cut if cut > CHUNK_CHARS // 2 else CHUNK_CHARS
            pieces.append(paragraph[:cut].strip())
            paragraph = paragraph[cut:].strip()
        current = f"{current}\n\n{paragraph}" if current else paragraph
    if current:
        pieces.append(current)
    return [f"{title}\n\n{piece}" for piece in pieces] or [title]


def folder_level(connection: sqlite3.Connection, source: str, folder: str) -> str:
    level = "normal"
    lowered = normal_folder(folder)
    for rule in connection.execute(
        "SELECT folder, confidentiality FROM folder_rule WHERE source IN (?, '*')", (source,)
    ):
        prefix = normal_folder(rule["folder"])
        if lowered == prefix or lowered.startswith(prefix + "/"):
            level = strictest(level, rule["confidentiality"])
    return level


def state(connection: sqlite3.Connection, source: str) -> dict[str, str]:
    rows = connection.execute("SELECT ref, revision FROM item WHERE class = 'note' AND source = ?", (source,))
    return {row["ref"]: row["revision"] for row in rows}


def upsert_notes(connection: sqlite3.Connection, source: str, source_name: str, notes: list[Note]) -> int:
    """Adds or replaces notes and their fragments; embeddings are recomputed for changed fragments."""
    stamp = now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        for note in notes:
            declared = declared_level(note.text)
            level = strictest(declared, folder_level(connection, source, note.folder))
            row = connection.execute(
                """INSERT INTO item (class, source, source_name, ref, title, folder, revision, modified_at,
                       declared_confidentiality, confidentiality, created_at, updated_at)
                   VALUES ('note', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (source, ref) DO UPDATE SET source_name = excluded.source_name, title = excluded.title,
                       folder = excluded.folder, revision = excluded.revision, modified_at = excluded.modified_at,
                       declared_confidentiality = excluded.declared_confidentiality,
                       confidentiality = excluded.confidentiality, updated_at = excluded.updated_at
                   RETURNING id""",
                (source, source_name, note.ref, note.title, note.folder, note.revision, note.modified_at,
                 declared, level, stamp, stamp),
            ).fetchone()
            connection.execute("DELETE FROM chunk WHERE item_id = ?", (row["id"],))
            connection.executemany(
                "INSERT INTO chunk (item_id, ord, text) VALUES (?, ?, ?)",
                [(row["id"], n, piece) for n, piece in enumerate(chunks(note.title, note.text))],
            )
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise
    return len(notes)


def remove_notes(connection: sqlite3.Connection, source: str, refs: list[str]) -> int:
    if not refs:
        return 0
    connection.execute("BEGIN IMMEDIATE")
    try:
        removed = 0
        for ref in refs:
            removed += connection.execute(
                "DELETE FROM item WHERE class = 'note' AND source = ? AND ref = ?", (source, ref)
            ).rowcount
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise
    return removed


class RuleError(ValueError):
    pass


def replace_folder_rules(connection: sqlite3.Connection, rules: list[tuple[str, str, str]]) -> int:
    """Replaces every folder rule and reclassifies the indexed notes. Returns how many changed level."""
    for _, folder, _ in rules:
        if not normal_folder(folder) or normal_folder(folder) in ("*", ".."):
            raise RuleError("Carpeta no válida en una regla de confidencialidad.")
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute("DELETE FROM folder_rule")
        connection.executemany(
            "INSERT OR REPLACE INTO folder_rule (source, folder, confidentiality) VALUES (?, ?, ?)",
            [(source, folder.strip().strip("/"), level) for source, folder, level in rules],
        )
        changed = 0
        for item in connection.execute(
            "SELECT id, source, folder, declared_confidentiality, confidentiality FROM item WHERE class = 'note'"
        ).fetchall():
            level = strictest(item["declared_confidentiality"], folder_level(connection, item["source"], item["folder"]))
            if level != item["confidentiality"]:
                connection.execute("UPDATE item SET confidentiality = ?, updated_at = ? WHERE id = ?", (level, now(), item["id"]))
                changed += 1
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise
    return changed


def status(connection: sqlite3.Connection) -> dict:
    one = lambda sql: connection.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "notes": one("SELECT count(*) FROM item WHERE class = 'note'"),
        "chunks": one("SELECT count(*) FROM chunk"),
        "pendingEmbeddings": one("SELECT count(*) FROM chunk WHERE embedding IS NULL"),
        "byConfidentiality": {
            row[0]: row[1]
            for row in connection.execute("SELECT confidentiality, count(*) FROM item WHERE class = 'note' GROUP BY 1")
        },
    }
