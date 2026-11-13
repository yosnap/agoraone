"""Local embeddings with ollama (only on this Mac) and the in-memory matrix used to search by meaning."""

import json
import sqlite3
import threading
import urllib.error
import urllib.request
from typing import Protocol
from urllib.parse import urlparse

import numpy as np

DEFAULT_MODEL = "qwen3-embedding:0.6b"
DEFAULT_URL = "http://127.0.0.1:11434"
BATCH = 32
# A fragment counts as related by meaning only if it stands out from the rest of the index: its similarity
# must be MIN_Z standard deviations above the mean. Calibrated on a real vault of ~1800 fragments, where
# nonsense queries peaked at z = 2.9 and real ones started at 3.5. Below MIN_CORPUS fragments the statistic
# is not reliable and every nearest fragment is kept.
MIN_Z = 3.2
MIN_CORPUS = 50
# Qwen3 embeddings expect queries (not documents) to carry the task.
QUERY_PREFIX = "Instruct: Given a question or keywords, retrieve the notes that answer it\nQuery: "


class EmbedError(RuntimeError):
    pass


class Embedder(Protocol):
    model: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class OllamaEmbedder:
    def __init__(self, url: str = DEFAULT_URL, model: str = DEFAULT_MODEL, timeout: float = 60):
        parsed = urlparse(url)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise EmbedError("ollama debe estar en este Mac (127.0.0.1): las notas no salen del equipo para indexarse.")
        self.url, self.model, self.timeout = url.rstrip("/"), model, timeout

    def embed(self, texts: list[str]) -> list[list[float]]:
        body = json.dumps({"model": self.model, "input": texts}).encode()
        request = urllib.request.Request(f"{self.url}/api/embed", body, {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                vectors = json.load(response).get("embeddings")
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            raise EmbedError(f"ollama no responde ({error}).") from error
        if not isinstance(vectors, list) or len(vectors) != len(texts):
            raise EmbedError("ollama devolvió una respuesta inesperada.")
        return vectors


def _normalised(vector: list[float]) -> np.ndarray:
    array = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(array))
    return array / norm if norm else array


def embed_pending(connection: sqlite3.Connection, embedder: Embedder, batch: int = BATCH) -> int:
    """Embeds up to `batch` fragments still without a vector (or embedded with another model)."""
    rows = connection.execute(
        "SELECT id, text FROM chunk WHERE embedding IS NULL OR embed_model IS NOT ? ORDER BY id LIMIT ?",
        (embedder.model, batch),
    ).fetchall()
    if not rows:
        return 0
    vectors = embedder.embed([row["text"] for row in rows])
    connection.executemany(
        "UPDATE chunk SET embedding = ?, embed_model = ? WHERE id = ? AND text = ?",
        [(_normalised(v).tobytes(), embedder.model, row["id"], row["text"]) for row, v in zip(rows, vectors)],
    )
    return len(rows)


class VectorCache:
    """Embedded fragments as one matrix, rebuilt only when the set of embedded fragments changes."""

    def __init__(self):
        self._lock = threading.Lock()
        self._signature = None
        self.ids = np.empty(0, dtype=np.int64)
        self.matrix = np.empty((0, 0), dtype=np.float32)

    def load(self, connection: sqlite3.Connection, model: str):
        signature = tuple(connection.execute(
            "SELECT count(*), coalesce(sum(id), 0), coalesce(max(id), 0) FROM chunk WHERE embed_model = ?", (model,)
        ).fetchone())
        with self._lock:
            if signature != self._signature:
                rows = connection.execute(
                    "SELECT id, embedding FROM chunk WHERE embed_model = ? AND embedding IS NOT NULL ORDER BY id", (model,)
                ).fetchall()
                self.ids = np.asarray([row["id"] for row in rows], dtype=np.int64)
                self.matrix = (
                    np.vstack([np.frombuffer(row["embedding"], dtype=np.float32) for row in rows])
                    if rows else np.empty((0, 0), dtype=np.float32)
                )
                self._signature = signature
            return self.ids, self.matrix

    def nearest(self, connection: sqlite3.Connection, embedder: Embedder, query: str, limit: int = 50) -> list[int] | None:
        """Nearest fragments, or None when search by meaning is not possible yet (nothing embedded)."""
        ids, matrix = self.load(connection, embedder.model)
        if not len(ids):
            return None
        vector = _normalised(embedder.embed([QUERY_PREFIX + query])[0])
        if vector.shape[0] != matrix.shape[1]:
            return None
        scores = matrix @ vector
        top = np.argsort(-scores)[:limit]
        if len(scores) >= MIN_CORPUS:
            spread = float(scores.std()) or 1.0
            top = [i for i in top if (scores[i] - scores.mean()) / spread >= MIN_Z]
        return [int(ids[i]) for i in top]
