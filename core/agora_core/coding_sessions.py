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


def roots(home: Path | None = None) -> list[tuple[str, Path, str | None]]:
    """(tool, folder of its records, where it runs when the folder says so): Orca keeps its own homes for the
    Claude Code and Codex it launches; the others say it in each record."""
    home = home or Path.home()
    found: list[tuple[str, Path, str | None]] = [("claude", home / ".claude" / "projects", None), ("codex", home / ".codex" / "sessions", None)]
    orca = home / "Library" / "Application Support" / "orca"
    profiles = orca / "claude-profiles"
    if profiles.is_dir() and not profiles.is_symlink():
        try:
            found += [("claude", profile / "home" / "projects", "orca") for profile in sorted(profiles.iterdir()) if profile.is_dir() and not profile.is_symlink()]
        except OSError:
            pass
    found.append(("codex", orca / "codex-runtime-home" / "home" / "sessions", "orca"))
    return found


_orca: dict = {"at": 0.0, "terminals": []}


def orca_terminals(runner=None, fresh: bool = False) -> list[dict]:
    """Orca's open terminals: their workspace folder, their handle and when they last showed output; never what they
    show. Read at most once a minute (or now, `fresh`); empty without Orca."""
    if not fresh and _orca["at"] and time.monotonic() - _orca["at"] < 60:
        return _orca["terminals"]
    from . import orca_launch

    try:
        listed = orca_launch._run(["terminal", "list"], runner or __import__("subprocess").run, 10).get("terminals")
    except orca_launch.OrcaError:
        listed = None
    found = [{"path": t["worktreePath"].rstrip("/"), "handle": t.get("handle") if isinstance(t.get("handle"), str) else None,
              "last": t.get("lastOutputAt") if isinstance(t.get("lastOutputAt"), (int, float)) else 0}
             for t in listed or [] if isinstance(t, dict) and t.get("connected") and isinstance(t.get("worktreePath"), str) and t["worktreePath"].startswith("/")]
    _orca.update(at=time.monotonic(), terminals=found)
    return found


def orca_folders(runner=None) -> list[str]:
    """The folders where Orca has a terminal open (its workspaces), the longest first."""
    return sorted({t["path"] for t in orca_terminals(runner)}, key=len, reverse=True)


def orca_target(session_id: str, runner=None) -> tuple[str, str | None] | None:
    """(the Orca workspace folder, the handle of its most recently active terminal) of a listed session, or None.
    Found by the session's own id: the screen never sends a path."""
    with _lock:
        cwd = next((r.cwd for key, r in _cache.items() if hashlib.sha256(key.encode()).hexdigest()[:12] == session_id), None)
    if not cwd:
        return None
    terminals = [t for t in orca_terminals(runner, fresh=True) if _in(cwd, [t["path"]])]
    if not terminals:
        return None
    longest = max(len(t["path"]) for t in terminals)
    best = max((t for t in terminals if len(t["path"]) == longest), key=lambda t: t["last"] or 0)
    return best["path"], best["handle"]


def open_in_orca(session_id: str, runner=None) -> None:
    """Shows that session's workspace in Orca and switches to its terminal, as the user asked with a click."""
    from . import orca_launch

    run = runner or __import__("subprocess").run
    target = orca_target(session_id, run)
    if target is None:
        raise orca_launch.OrcaError("Esa sesión ya no está en un espacio de trabajo abierto en Orca.")
    path, handle = target
    orca_launch._run(["worktree", "activate", f"--worktree=path:{path}"], run, 20)
    if handle:
        orca_launch._run(["terminal", "switch", f"--terminal={handle}"], run, 10)


def _in(folder: str | None, places: list[str]) -> bool:
    return bool(folder) and any(folder == place or folder.startswith(place + "/") for place in places)


def host(tool: str, origin: str | None) -> str | None:
    """Where a session runs, from what its record says: «vscode», «codex-app», «claude-desktop», «terminal» or «sdk»."""
    said = (origin or "").lower()
    if not said:
        return None
    if tool == "codex" and "desktop" in said:
        return "codex-app"  # the Codex app (it says «Codex Desktop», over a VS Code-like source)
    if "vscode" in said or "cursor" in said:
        return "vscode"
    if "desktop" in said:
        return "claude-desktop"
    if said.startswith("sdk"):
        return "sdk"
    if said in ("cli", "codex_cli_rs", "codex_exec", "exec") or said.startswith("codex_cli"):
        return "terminal"
    return None


def _recent_files(tool: str, root: Path, since: float) -> list[Path]:
    """The .jsonl records moved since then: Claude Code keeps one folder per project, Codex one per day."""
    if not root.is_dir() or root.is_symlink():
        return []
    if tool == "claude":
        try:
            folders = [f for f in root.iterdir() if f.is_dir() and not f.is_symlink()]
        except OSError:
            return []
    else:
        # Codex names the day folder by local date: a day either side covers any time zone. A session older than
        # that and resumed today writes in its first day's folder and is not seen (accepted).
        days = {(datetime.fromtimestamp(since, UTC) + timedelta(days=d)).strftime("%Y/%m/%d") for d in range(-1, 3)}
        folders = [root / day for day in days if (root / day).is_dir() and not (root / day).is_symlink()]
    out = []
    for folder in folders:  # a folder's own date does not move when a file in it grows: every file is looked at
        try:
            files = list(folder.glob("*.jsonl"))
        except OSError:
            continue
        for file in files:
            try:
                if not file.is_symlink() and file.is_file() and file.stat().st_mtime >= since:
                    out.append(file)
            except OSError:
                continue
    return out


def _number(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _text(value) -> str | None:
    """A metadata field only when it is plain text written by the tool (never an internal «<synthetic>» value)."""
    return value if isinstance(value, str) and value and not value.startswith("<") else None


def _said(message) -> str:
    """The start of what a user line says, only to tell a real prompt from an interruption or a local command.
    It is looked at here and dropped: nothing of it is kept."""
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content[:80]
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "tool_result":
                return "<tool_result>"
            if isinstance(part, dict) and part.get("type") == "text":
                return str(part.get("text") or "")[:80]
    return ""


def _stamp(text) -> float | None:
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


class _Record:
    """What is known of one session file so far."""

    def __init__(self, tool: str):
        self.tool, self.offset, self.size = tool, 0, 0
        self.cwd = self.branch = self.model = self.origin = None
        self.started: float | None = None
        self.last: float | None = None
        self.turn_open = False  # a turn under way: the user asked, or a tool is running or waiting for permission
        self.tool_pending = False  # the last answer asked for a tool that has not answered yet (running, or your permission)
        self.total = None  # Codex: the session's running total, to skip repeated token events
        self.usage: dict[str, tuple[float, int, int]] = {}  # message or turn id -> (when, input, output)

    def read(self, line: dict):
        at = _stamp(line.get("timestamp"))
        if at:
            self.started = self.started or at
            self.last = max(self.last or at, at)
        (self._claude if self.tool == "claude" else self._codex)(line, at)

    def _claude(self, line: dict, at):
        self.cwd = self.cwd or _text(line.get("cwd"))  # where it started: later «cd» into subfolders do not rename it
        self.origin = self.origin or _text(line.get("entrypoint"))
        self.branch = _text(line.get("gitBranch")) or self.branch
        message = line.get("message")
        if line.get("type") == "assistant" and isinstance(message, dict):
            self.model = _text(message.get("model")) or self.model
            stop = message.get("stop_reason")
            if stop:
                self.turn_open = self.tool_pending = stop == "tool_use"
            usage = message.get("usage")
            if isinstance(usage, dict) and at:
                ins = _number(usage.get("input_tokens")) + _number(usage.get("cache_creation_input_tokens"))
                # The same message is written again as it streams: counted once, by its id.
                self.usage[str(message.get("id") or line.get("uuid"))] = (at, ins, _number(usage.get("output_tokens")))
        elif line.get("type") == "user" and not line.get("isMeta"):
            said = _said(message)
            if said == "<tool_result>":
                self.turn_open, self.tool_pending = True, False  # the tool answered: Claude goes on
            elif said.startswith("[Request interrupted"):
                self.turn_open = self.tool_pending = False  # stopped with Esc: it waits for you
            elif said and not said.startswith(("<local-command", "<command-name>", "<command-message>")):
                self.turn_open, self.tool_pending = True, False  # a real prompt

    def _codex(self, line: dict, at):
        payload = line.get("payload") if isinstance(line.get("payload"), dict) else {}
        kind = line.get("type")
        if kind in ("session_meta", "turn_context"):
            self.cwd = self.cwd or _text(payload.get("cwd"))
            if kind == "session_meta":
                self.origin = self.origin or _text(payload.get("originator")) or _text(payload.get("source"))
            self.model = _text(payload.get("model")) or self.model
        elif kind == "event_msg":
            event = str(payload.get("type") or "")
            if event == "task_started":
                self.turn_open, self.tool_pending = True, False
            elif event in ("task_complete", "turn_aborted"):
                self.turn_open = self.tool_pending = False
            elif "approval_request" in event:
                self.tool_pending = True
            elif event == "token_count" and isinstance(payload.get("info"), dict) and at:
                info = payload["info"]
                total = (info.get("total_token_usage") or {}).get("total_tokens")
                if total is not None and total == self.total:
                    return  # the same count written again
                self.total = total
                last = info.get("last_token_usage") or {}
                ins = _number(last.get("input_tokens")) - _number(last.get("cached_input_tokens"))
                self.usage[f"{at}:{len(self.usage)}"] = (at, max(0, ins), _number(last.get("output_tokens")))


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
    try:
        with file.open("rb") as handle:
            handle.seek(record.offset)
            while True:
                raw = handle.readline(MAX_LINE + 1)
                if not raw or not raw.endswith(b"\n"):
                    if len(raw) > MAX_LINE:  # a huge line (a big tool result): skipped without keeping it whole
                        skipped = len(raw)
                        while raw and not raw.endswith(b"\n"):
                            raw = handle.readline(MAX_LINE + 1)
                            skipped += len(raw)
                        if raw:
                            record.offset += skipped
                            continue
                    break  # a line still being written: read next time
                record.offset += len(raw)
                try:
                    line = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(line, dict):
                    record.read(line)
    except OSError:  # gone or rotated between looking at it and opening it
        return None
    record.size = size
    return record


def sessions(now: float | None = None, home: Path | None = None, orca: list[str] | None = None) -> list[dict]:
    """`orca`: the folders of Orca's open terminals (read from Orca when not given): Claude Code launched by Orca
    writes where the terminal one does, so its folder is what tells them apart."""
    now = now or time.time()
    places = orca_folders() if orca is None else orca
    since = now - WINDOW.total_seconds()
    out, seen = [], set()
    with _lock:
        for tool, root, fixed in roots(home):
            for file in _recent_files(tool, root, since):
                seen.add(str(file))
                record = _update(tool, file)
                if record is None or record.last is None:
                    continue
                try:
                    moved = file.stat().st_mtime
                except OSError:
                    continue
                quiet = now - max(moved, record.last)
                # A tool asked for and not answered: running something long or waiting for your permission (the
                # records do not say which), so it is told as such instead of «working» or «paused».
                state = ("working" if quiet < WORKING else "tool" if quiet < WAITING else "paused") if record.tool_pending and record.turn_open \
                    else "working" if quiet < WORKING and record.turn_open else "waiting" if quiet < WAITING and not record.turn_open else "paused"
                record.usage = {k: u for k, u in record.usage.items() if u[0] >= since}  # only the last 24 h is kept
                day = list(record.usage.values())
                out.append({
                    "id": hashlib.sha256(str(file).encode()).hexdigest()[:12], "tool": tool, "host": fixed or ("orca" if _in(record.cwd, places) else host(tool, record.origin)), "inOrca": _in(record.cwd, places),
                    "project": Path(record.cwd).name[:80] if record.cwd else None, "branch": record.branch[:80] if record.branch else None,
                    "model": record.model[:60] if record.model else None, "state": state,
                    "startedAt": _iso(record.started), "lastAt": _iso(max(moved, record.last)),
                    "tokens": {"input": sum(u[1] for u in day), "output": sum(u[2] for u in day)}, "turns": len(day),
                })
        # Only the files still in the window stay in the cache (by the file's date, which is what puts it in the
        # list: Claude Code appends lines without a time, so the content's last time can be older).
        for key in set(_cache) - seen:
            _cache.pop(key, None)
    out.sort(key=lambda s: s["lastAt"], reverse=True)
    return out[:MAX_SESSIONS]


def _iso(at: float | None) -> str | None:
    return datetime.fromtimestamp(at, UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if at else None
