"""Hybrid search over the index: words (FTS5, accent-insensitive) and meaning (local embeddings), fused by
rank. Every search names its audience and the core removes what that audience may not see before ranking:
`owner` (the user on this Mac) sees everything; `external` (a model outside this Mac, Telegram, MCP)
never gets `local_only` or `private` items."""

import re
import sqlite3

from .embed import EmbedError, Embedder, VectorCache

RRF_K = 60
CANDIDATES = 50
AUDIENCES = {"owner": (), "external": ("local_only", "private")}


def fts_query(text: str) -> str | None:
    """Each word quoted (no FTS syntax from the user) and with prefix matching; any word may match."""
    words = [w for w in re.findall(r"\w+", text, re.UNICODE) if len(w) > 1][:12]
    return " OR ".join(f'"{w}"*' for w in words) or None


def search(
    connection: sqlite3.Connection, query: str, embedder: Embedder | None, cache: VectorCache,
    audience: str, limit: int = 10, with_text: bool = False,
) -> dict:
    """`with_text` adds the whole best fragment of each result (for the assistant's context)."""
    if audience not in AUDIENCES:
        raise ValueError("Audiencia de búsqueda no válida.")
    exclude = AUDIENCES[audience]
    hidden = ",".join(f"'{level}'" for level in exclude) or "''"
    ranks: dict[int, float] = {}
    snippets: dict[int, str] = {}
    matched: dict[int, set[str]] = {}
    expression = fts_query(query)
    if expression:
        rows = connection.execute(
            f"""SELECT chunk.id, snippet(chunk_fts, 0, '«', '»', '…', 16) AS snippet
               FROM chunk_fts JOIN chunk ON chunk.id = chunk_fts.rowid JOIN item ON item.id = chunk.item_id
               WHERE chunk_fts MATCH ? AND item.confidentiality NOT IN ({hidden})
               ORDER BY bm25(chunk_fts) LIMIT ?""",
            (expression, CANDIDATES),
        ).fetchall()
        for rank, row in enumerate(rows):
            ranks[row["id"]] = ranks.get(row["id"], 0) + 1 / (RRF_K + rank)
            snippets[row["id"]] = row["snippet"]
            matched.setdefault(row["id"], set()).add("words")
    semantic = False
    if embedder is not None and query.strip():
        try:
            nearest = cache.nearest(connection, embedder, query, CANDIDATES, exclude)
        except EmbedError:
            nearest = None
        for rank, chunk_id in enumerate(nearest or []):
            ranks[chunk_id] = ranks.get(chunk_id, 0) + 1 / (RRF_K + rank)
            matched.setdefault(chunk_id, set()).add("meaning")
        semantic = nearest is not None
    if not ranks:
        return {"results": [], "semantic": semantic}
    placeholders = ",".join("?" * len(ranks))
    rows = connection.execute(
        f"""SELECT chunk.id AS chunk_id, chunk.text, item.id, item.source, item.source_name, item.ref, item.title,
                   item.folder, item.modified_at, item.confidentiality
            FROM chunk JOIN item ON item.id = chunk.item_id WHERE chunk.id IN ({placeholders})""",
        list(ranks),
    ).fetchall()
    best: dict[int, dict] = {}
    for row in rows:
        if row["confidentiality"] in exclude:
            continue
        score = ranks[row["chunk_id"]]
        current = best.get(row["id"])
        if current is None or score > current["score"]:
            body = row["text"].split("\n\n", 1)[-1]
            best[row["id"]] = {
                "source": row["source"], "sourceName": row["source_name"], "ref": row["ref"], "title": row["title"],
                "folder": row["folder"], "modifiedAt": row["modified_at"], "confidentiality": row["confidentiality"],
                "snippet": snippets.get(row["chunk_id"]) or body[:240], "score": round(score, 6),
                "matchedBy": sorted(matched[row["chunk_id"]]),
                **({"text": body} if with_text else {}),
            }
    results = sorted(best.values(), key=lambda r: r["score"], reverse=True)[:limit]
    return {"results": results, "semantic": semantic}
