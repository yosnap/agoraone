"""The brain's graph: every indexed note as a node, its [[links]] resolved by title inside the same vault,
and optionally the notes closest in meaning. Read only and for the owner on this Mac; discreet mode keeps
only `normal` notes, so nothing else appears on screen."""

import sqlite3

import numpy as np

from .embed import Embedder, VectorCache
from .index import link_key

MAX_NODES = 1500
NEAR_PER_NOTE = 3
# A pair counts as near when its similarity stands this many deviations above the average pair: relative,
# so it works with any embedding model.
NEAR_MIN_Z = 2.0


def _pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def _near_pairs(connection: sqlite3.Connection, embedder: Embedder, cache: VectorCache, ids: list[int]) -> set[tuple[int, int]] | None:
    """Pairs of notes whose average fragment vectors are closest; None when nothing is embedded."""
    chunk_ids, _, matrix = cache.load(connection, embedder.model)
    if not len(chunk_ids):
        return None
    wanted = set(ids)
    owner = dict(connection.execute("SELECT id, item_id FROM chunk WHERE embedding IS NOT NULL").fetchall())
    rows: dict[int, list[int]] = {}
    for position, chunk_id in enumerate(chunk_ids.tolist()):
        item = owner.get(chunk_id)
        if item in wanted:
            rows.setdefault(item, []).append(position)
    items = list(rows)
    if len(items) < 3:
        return set()
    vectors = np.vstack([matrix[rows[item]].mean(axis=0) for item in items])
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors = vectors / np.where(norms == 0, 1, norms)
    similarity = vectors @ vectors.T
    np.fill_diagonal(similarity, np.nan)
    mean, spread = float(np.nanmean(similarity)), float(np.nanstd(similarity)) or 1.0
    np.fill_diagonal(similarity, -np.inf)
    pairs: set[tuple[int, int]] = set()
    for row, item in enumerate(items):
        for column in np.argsort(-similarity[row])[:NEAR_PER_NOTE]:
            if (similarity[row, column] - mean) / spread >= NEAR_MIN_Z:
                pairs.add(_pair(item, items[int(column)]))
    return pairs


def graph(
    connection: sqlite3.Connection, embedder: Embedder | None, cache: VectorCache, discreet: bool, near: bool,
) -> dict:
    hidden = "AND confidentiality = 'normal'" if discreet else ""
    total = connection.execute(f"SELECT count(*) FROM item WHERE class = 'note' {hidden}").fetchone()[0]
    rows = connection.execute(
        f"""SELECT id, source, source_name, ref, title, folder, confidentiality FROM item
            WHERE class = 'note' {hidden} ORDER BY modified_at DESC, id LIMIT ?""",
        (MAX_NODES,),
    ).fetchall()
    by_id = {row["id"]: row for row in rows}
    titles: dict[tuple[str, str], int] = {}
    for row in sorted(rows, key=lambda r: r["id"]):
        titles.setdefault((row["source"], link_key(row["title"] or "")), row["id"])
    edges: dict[tuple[int, int], str] = {}
    placeholders = ",".join("?" * len(by_id)) or "NULL"
    for link in connection.execute(f"SELECT item_id, target FROM note_link WHERE item_id IN ({placeholders})", list(by_id)):
        source = by_id[link["item_id"]]["source"]
        target = titles.get((source, link["target"]))
        if target is not None and target != link["item_id"]:
            edges[_pair(link["item_id"], target)] = "link"
    semantic = False
    if near and embedder is not None:
        pairs = _near_pairs(connection, embedder, cache, list(by_id))
        semantic = pairs is not None
        for pair in pairs or ():
            edges.setdefault(pair, "near")
    degree: dict[int, int] = {}
    for a, b in edges:
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) + 1
    key = lambda item: f"{by_id[item]['source']}/{by_id[item]['ref']}"  # noqa: E731
    return {
        "nodes": [
            {"id": key(row["id"]), "source": row["source"], "sourceName": row["source_name"], "ref": row["ref"],
             "title": row["title"], "folder": row["folder"], "confidentiality": row["confidentiality"],
             "degree": degree.get(row["id"], 0)}
            for row in rows
        ],
        "edges": [{"a": key(a), "b": key(b), "kind": kind} for (a, b), kind in edges.items()],
        "total": total,
        "truncated": total > len(rows),
        "semantic": semantic,
    }
