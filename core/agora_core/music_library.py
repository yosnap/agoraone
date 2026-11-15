"""The user's own music (1.5): the folders they pick, indexed by artist, album and title (from the folders'
layout and the file names: Artista/Álbum/01 Título.mp3 or «Artista - Título.mp3»), searched without accents and
played by AgoraOne's own player. A file is only ever served from inside those folders. YouTube is opened in the
user's browser with a search, never embedded."""

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
from pathlib import Path

from .db import transaction

SETTING = "music.library"
SUFFIXES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg"}
MAX_FILES = 20000
MAX_DEPTH = 6
CACHE_SECONDS = 600
_cache: dict = {}
_choosing = threading.Lock()


class LibraryError(RuntimeError):
    pass


def plain(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text.lower()) if unicodedata.category(c) != "Mn")


def folders(connection: sqlite3.Connection) -> list[str]:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    return [f for f in (json.loads(row["value"]).get("folders", []) if row else []) if isinstance(f, str)]


def save_folders(connection: sqlite3.Connection, chosen: list[str]) -> list[str]:
    clean = []
    for folder in chosen[:10]:
        path = Path(folder).expanduser()
        if not path.is_absolute() or not path.is_dir() or path == Path("/") or "\x00" in folder:
            raise LibraryError(f"«{folder}» no es una carpeta de este equipo.")
        if str(path.resolve()) not in clean:
            clean.append(str(path.resolve()))
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                           (SETTING, json.dumps({"folders": clean})))
    _cache.clear()
    return clean


def choose() -> str | None:
    """macOS's folder chooser; None if cancelled or on another system (there the path is typed)."""
    if sys.platform != "darwin":
        return None
    if not _choosing.acquire(blocking=False):
        raise LibraryError("Ya hay un selector de carpetas abierto.")
    try:
        done = subprocess.run(["/usr/bin/osascript", "-e", 'POSIX path of (choose folder with prompt "Elige tu carpeta de música")'],
                              capture_output=True, text=True, timeout=110, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    finally:
        _choosing.release()
    return (done.stdout or "").strip().rstrip("/") or None if done.returncode == 0 else None


def _track(root: Path, path: Path) -> dict:
    parts = path.relative_to(root).parts
    stem = re.sub(r"^\s*(\d{1,3}[\s.\-_]+)+", "", path.stem).strip() or path.stem
    artist, title = None, stem
    if " - " in stem:
        artist, title = [p.strip() for p in stem.split(" - ", 1)]
    album = parts[-2] if len(parts) >= 2 else None
    if artist is None and len(parts) >= 3:
        artist = parts[-3]
    ident = hashlib.sha1(str(path).encode()).hexdigest()[:16]
    return {"id": ident, "title": title, "artist": artist, "album": album, "path": str(path)}


def index(roots: list[str]) -> list[dict]:
    key = tuple(roots)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    tracks: list[dict] = []
    for folder in roots:
        root = Path(folder)
        for current, dirs, files in os.walk(root):
            depth = len(Path(current).relative_to(root).parts)
            dirs[:] = [d for d in dirs if not d.startswith(".")] if depth < MAX_DEPTH else []
            for name in files:
                if Path(name).suffix.lower() in SUFFIXES and not name.startswith("."):
                    tracks.append(_track(root, Path(current) / name))
                    if len(tracks) >= MAX_FILES:
                        break
            if len(tracks) >= MAX_FILES:
                break
    tracks.sort(key=lambda t: (plain(t["artist"] or "~"), plain(t["album"] or ""), plain(t["title"])))
    _cache[key] = (time.monotonic(), tracks)
    return tracks


def search(connection: sqlite3.Connection, query: str, limit: int = 50) -> list[dict]:
    words = plain(query).split()
    found = [t for t in index(folders(connection)) if all(w in plain(f"{t['title']} {t['artist'] or ''} {t['album'] or ''}") for w in words)]
    return [{k: v for k, v in t.items() if k != "path"} for t in found[:limit]]


def file_of(connection: sqlite3.Connection, ident: str) -> tuple[Path, str]:
    roots = [Path(f) for f in folders(connection)]
    track = next((t for t in index([str(r) for r in roots]) if t["id"] == ident), None)
    if not track:
        raise LibraryError("Esa canción ya no está en tu biblioteca.")
    path = Path(track["path"]).resolve()
    if not any(root in path.parents for root in roots) or not path.is_file():
        raise LibraryError("Esa canción ya no está en tu biblioteca.")
    return path, SUFFIXES[path.suffix.lower()]


def youtube(query: str) -> str:
    """Opens a YouTube search in the user's browser; nothing is embedded or downloaded."""
    query = " ".join((query or "").split())[:120]
    if not query:
        raise LibraryError("Di qué quieres ver en YouTube.")
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": query})
    try:
        if sys.platform == "win32":
            os.startfile(url)  # never through cmd.exe, which would read the URL's % and &
        else:
            subprocess.run(["/usr/bin/open", url] if sys.platform == "darwin" else ["xdg-open", url], capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise LibraryError("No se pudo abrir el navegador.") from error
    return f"Abierta la búsqueda de «{query}» en YouTube, en tu navegador."
