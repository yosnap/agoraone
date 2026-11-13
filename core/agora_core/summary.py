"""The summary page's numbers from the core: how long it has been up, what Watson has been asked and how
much each answer drew on the brain, the words used most in the notes and in the questions, and token
use per project from CostGuard. Read only; for the owner's screen, never sent to a model."""

import json
import re
import sqlite3
import threading
from collections import Counter
from functools import cache
from pathlib import Path

WORD = re.compile(r"[^\W\d_]{4,20}")
LOOKS_LIKE_KEY = re.compile(r"[^\W\d_]{21,}|[A-Za-z]+\d|\d+[A-Za-z]")
TOP_WORDS = 40


@cache
def stopwords() -> frozenset[str]:
    # Shared with the backend (server/hermes-summary.ts), so both count words by the same rules.
    path = Path(__file__).resolve().parents[2] / "shared" / "stopwords.json"
    try:
        return frozenset(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return frozenset()


def count_words(texts, counter: Counter | None = None) -> Counter:
    counter = counter if counter is not None else Counter()
    stop = stopwords()
    for text in texts:
        for piece in text.split():
            if len(piece) > 40 or LOOKS_LIKE_KEY.search(piece):
                continue
            for word in WORD.findall(piece.lower()):
                if word not in stop and len(set(word)) > 1:
                    counter[word] += 1
    return counter


def top(counter: Counter, n: int = TOP_WORDS) -> list[dict]:
    return [{"word": w, "count": c} for w, c in sorted(counter.items(), key=lambda i: (-i[1], i[0]))[:n]]


class NoteWords:
    """Word counts of the notes, rebuilt only when the index changes (its vector generation counter)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._cached: dict[bool, tuple] = {}

    def get(self, connection: sqlite3.Connection, discreet: bool) -> list[dict]:
        signature = (
            connection.execute("SELECT n FROM vector_generation WHERE only = 1").fetchone()[0],
            connection.execute("SELECT count(*), max(updated_at) FROM item WHERE class = 'note'").fetchone()[:],
        )
        with self._lock:
            cached = self._cached.get(discreet)
            if cached and cached[0] == signature:
                return cached[1]
        hidden = "AND item.confidentiality = 'normal'" if discreet else ""
        texts = (row[0].split("\n\n", 1)[-1] for row in connection.execute(
            f"SELECT chunk.text FROM chunk JOIN item ON item.id = chunk.item_id WHERE item.class = 'note' {hidden}"
        ))
        words = top(count_words(texts))
        with self._lock:
            self._cached[discreet] = (signature, words)
        return words


def watson(connection: sqlite3.Connection) -> dict:
    one = lambda sql, *a: connection.execute(sql, a).fetchone()[0]  # noqa: E731
    rows = connection.execute(
        """SELECT q.content AS question, q.created_at AS at, a.sources AS sources
           FROM message q JOIN message a ON a.conversation_id = q.conversation_id AND a.role = 'assistant'
             AND a.id = (SELECT min(id) FROM message WHERE conversation_id = q.conversation_id AND id > q.id)
           WHERE q.role = 'user' AND q.failed = 0 ORDER BY q.id DESC LIMIT 500"""
    ).fetchall()
    cited: Counter = Counter()
    titles: dict[tuple, dict] = {}
    impact = []
    for row in rows:
        sources = json.loads(row["sources"] or "[]")
        impact.append({"question": row["question"][:160], "at": row["at"], "sources": len(sources)})
        for source in sources:
            key = (source["source"], source["ref"])
            cited[key] += 1
            titles[key] = {"title": source["title"], "folder": source["folder"], "source": key[0], "ref": key[1]}
    searches = Counter()
    for (detail,) in connection.execute("SELECT detail FROM action_log WHERE actor = 'watson' AND action = 'buscar' ORDER BY id DESC LIMIT 2000"):
        query = (json.loads(detail or "{}").get("query") or "").strip().lower()
        if query:
            searches[query] += 1
    return {
        "conversations": one("SELECT count(*) FROM conversation"),
        "questions": one("SELECT count(*) FROM message WHERE role = 'user'"),
        "questions24h": one("SELECT count(*) FROM message WHERE role = 'user' AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')"),
        "failed": one("SELECT count(*) FROM message WHERE role = 'user' AND failed = 1"),
        "impact": sorted(impact, key=lambda i: (i["sources"], i["at"]), reverse=True)[:8],
        "cited": [{**titles[key], "count": n} for key, n in cited.most_common(10)],
        "searches": [{"query": q, "count": n} for q, n in searches.most_common(10)],
        "words": top(count_words(r[0] for r in connection.execute("SELECT content FROM message WHERE role = 'user'"))),
    }
