"""Coding agents working on this Mac (1.7, «Agentes» section): the Claude Code and Codex sessions moved in the last
24 h, read from their own local records. Only metadata: the project folder's name, the branch, the model, when it
started and last moved, whether it is working or waiting, and the tokens of the last 24 h. The text of the
conversation (messages, tool inputs and results, attachments) is never kept nor returned, and nothing here goes to
a model. The folders are fixed here, never taken from the client, and symbolic links are not followed.

The records can be tens of megabytes, so each file is read once and then only what was appended since (the offset
is kept per file and started again if the file shrinks)."""

import hashlib
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

WINDOW = timedelta(hours=24)
WORKING = 120  # seconds since the record last moved to count as working
WAITING = 30 * 60  # a finished turn this recent: waiting for the user
MAX_SESSIONS = 40
MAX_LINE = 4 * 1024 * 1024  # a longer line (a huge tool result) is skipped without parsing


def roots(home: Path | None = None) -> list[tuple[str, Path]]:
    home = home or Path.home()
    found = [("claude", home / ".claude" / "projects"), ("codex", home / ".codex" / "sessions")]
    orca = home / "Library" / "Application Support" / "orca" / "claude-profiles"
    if orca.is_dir() and not orca.is_symlink():
        found += [("claude", profile / "home" / "projects") for profile in sorted(orca.iterdir()) if profile.is_dir() and not profile.is_symlink()]
    return found


def _recent_files(tool: str, root: Path, since: float) -> list[Path]:
    """The .jsonl records moved since then: Claude Code keeps one folder per project, Codex one per day."""
    if not root.is_dir() or root.is_symlink():
        return []
    if tool == "claude":
        folders = [f for f in root.iterdir() if f.is_dir() and not f.is_symlink()]
    else:
        days = {(datetime.fromtimestamp(since, UTC) + timedelta(days=d)).strftime("%Y/%m/%d") for d in range(3)}
        folders = [root / day for day in days if (root / day).is_dir() and not (root / day).is_symlink()]
    out = []
    for folder in folders:  # a folder's own date does not move when a file in it grows: every file is looked at
        for file in folder.glob("*.jsonl"):
            try:
                if not file.is_symlink() and file.is_file() and file.stat().st_mtime >= since:
                    out.append(file)
            except OSError:
                continue
    return out


def _stamp(text) -> float | None:
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


class _Record:
    """What is known of one session file so far."""

    def __init__(self, tool: str):
        self.tool, self.offset, self.size = tool, 0, 0
        self.cwd = self.branch = self.model = None
        self.started: float | None = None
        self.last: float | None = None
        self.turn_open = False  # Codex: a task started and not completed; Claude: the last answer asked for a tool
        self.usage: dict[str, tuple[float, int, int]] = {}  # message or turn id -> (when, input, output)

    def read(self, line: dict):
        at = _stamp(line.get("timestamp"))
        if at:
            self.started = self.started or at
            self.last = max(self.last or at, at)
        (self._claude if self.tool == "claude" else self._codex)(line, at)

    def _claude(self, line: dict, at):
        self.cwd = self.cwd or line.get("cwd")  # where it started: later «cd» into subfolders do not rename it
        self.branch = line.get("gitBranch") or self.branch
        message = line.get("message") if line.get("type") == "assistant" else None
        if isinstance(message, dict):
            self.model = message.get("model") or self.model
            stop = message.get("stop_reason")
            if stop:
                self.turn_open = stop == "tool_use"
            usage = message.get("usage")
            if isinstance(usage, dict) and at:
                ins = sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens"))
                # The same message is written again as it streams: counted once, by its id.
                self.usage[str(message.get("id") or line.get("uuid"))] = (at, ins, int(usage.get("output_tokens") or 0))
        elif line.get("type") == "user":
            self.turn_open = True  # the user wrote, or a tool answered: Claude is on it

    def _codex(self, line: dict, at):
        payload = line.get("payload") if isinstance(line.get("payload"), dict) else {}
        kind = line.get("type")
        if kind in ("session_meta", "turn_context"):
            self.cwd = self.cwd or payload.get("cwd")
            self.model = payload.get("model") or self.model
        elif kind == "event_msg":
            event = payload.get("type")
            if event == "task_started":
                self.turn_open = True
            elif event == "task_complete":
                self.turn_open = False
            elif event == "token_count" and isinstance(payload.get("info"), dict) and at:
                last = payload["info"].get("last_token_usage") or {}
                ins = int(last.get("input_tokens") or 0) - int(last.get("cached_input_tokens") or 0)
                self.usage[f"{at}:{len(self.usage)}"] = (at, max(0, ins), int(last.get("output_tokens") or 0))


_cache: dict[str, _Record] = {}
_lock = threading.Lock()


def _update(tool: str, file: Path) -> _Record | None:
    key = str(file)
    try:
        size = file.stat().st_size
    except OSError:
        return None
    record = _cache.get(key)
    if record is None or size < record.offset:
        record = _cache[key] = _Record(tool)
    if size == record.offset:
        return record
    with file.open("rb") as handle:
        handle.seek(record.offset)
        for raw in handle:
            if not raw.endswith(b"\n"):
                break  # a line still being written: read next time
            record.offset += len(raw)
            if len(raw) > MAX_LINE:
                continue
            try:
                line = json.loads(raw)
            except ValueError:
                continue
            if isinstance(line, dict):
                record.read(line)
    record.size = size
    return record


def sessions(now: float | None = None, home: Path | None = None) -> list[dict]:
    now = now or time.time()
    since = now - WINDOW.total_seconds()
    out = []
    with _lock:
        for tool, root in roots(home):
            for file in _recent_files(tool, root, since):
                record = _update(tool, file)
                if record is None or record.last is None:
                    continue
                try:
                    moved = file.stat().st_mtime
                except OSError:
                    continue
                quiet = now - max(moved, record.last)
                state = "working" if quiet < WORKING and record.turn_open else "waiting" if quiet < WAITING and not record.turn_open else "paused"
                day = [u for u in record.usage.values() if u[0] >= since]
                out.append({
                    "id": hashlib.sha256(str(file).encode()).hexdigest()[:12], "tool": tool,
                    "project": Path(record.cwd).name[:80] if record.cwd else None, "branch": (record.branch or None) and str(record.branch)[:80],
                    "model": (record.model or None) and str(record.model)[:60], "state": state,
                    "startedAt": _iso(record.started), "lastAt": _iso(max(moved, record.last)),
                    "tokens": {"input": sum(u[1] for u in day), "output": sum(u[2] for u in day)}, "turns": len(day),
                })
        # Files gone or quiet for more than a day leave the cache.
        for key in [k for k, r in _cache.items() if (r.last or 0) < since - 3600]:
            _cache.pop(key, None)
    out.sort(key=lambda s: s["lastAt"], reverse=True)
    return out[:MAX_SESSIONS]


def _iso(at: float | None) -> str | None:
    return datetime.fromtimestamp(at, UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if at else None
