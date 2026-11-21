"""AgoraOne's own log: what happens in the app (start, warnings, errors of the core and of the interface).

One JSON object per line in `<data>/logs/agoraone.log`, rotated at 1 MB with four older files, so it never grows
without limit. It stays on this computer: it is never sent to a model or anywhere else. Lines that look like a key
are replaced and every message is cut short; request bodies, mail and message texts are never logged.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import traceback
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_NAME = "agoraone.log"
MAX_BYTES = 1_000_000
BACKUPS = 4
MAX_MESSAGE = 1000
LEVELS = ("debug", "info", "warning", "error")
SOURCES = ("núcleo", "interfaz")

# Same idea as the hidden lines elsewhere in AgoraOne: «password: …», «token=…», and bare tokens with a known prefix.
_KEY_LINE = re.compile(r"(?i)(contrase(n|ñ)a|password|passwd|api[_ -]?key|token|secret|clave|authorization|bearer)(\s*[:=]\s*|\s+)\S{6,}")
# Query strings of addresses (an error of an HTTP client prints the whole URL, keys included).
_URL_QUERY = re.compile(r"((?:https?|wss?)://[^\s?#]+)[?#]\S*", re.I)
_KEY_PARAM = re.compile(r"(?i)\b(key|apikey|api_key|access_token|token|secret|password|sig|signature)=[^\s&]+")
_BARE_KEY = re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})")
_HIDDEN = "[oculto: parece una clave]"


def clean(message: str) -> str:
    """The text that may be written: lines that look like a key hidden, control characters out, cut short."""
    lines = []
    for line in str(message).splitlines():
        line = _KEY_PARAM.sub(r"\1=[oculto]", _URL_QUERY.sub(r"\1?…", line))
        lines.append(_HIDDEN if _KEY_LINE.search(line) else _BARE_KEY.sub("[oculto]", line))
    text = " ⏎ ".join(line.strip() for line in lines if line.strip())
    text = "".join(ch for ch in text if ch >= " " or ch == "\t")
    return text if len(text) <= MAX_MESSAGE else text[: MAX_MESSAGE - 1] + "…"


class _JsonLines(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage()
        if record.exc_info and record.exc_info[1] is not None:
            error = record.exc_info[1]
            message = f"{message}: {type(error).__name__}: {error}" if message else f"{type(error).__name__}: {error}"
            frames = traceback.extract_tb(record.exc_info[2]) if record.exc_info[2] else []
            if frames:  # where it failed, without any values: file, line and function of the last frame
                last = frames[-1]
                message += f" (en {Path(last.filename).name}:{last.lineno}, {last.name})"
        source = getattr(record, "source", "núcleo")
        area = getattr(record, "area", None) or record.name.removeprefix("agora_core").strip(".") or "núcleo"
        entry = {
            "t": datetime.fromtimestamp(record.created, UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "level": record.levelname.lower() if record.levelname.lower() in LEVELS else "info",
            "source": source if source in SOURCES else "núcleo",
            "area": clean(area)[:60],
            "message": clean(message),
        }
        return json.dumps(entry, ensure_ascii=False)


_lock = threading.Lock()


def log_path(data_dir: Path) -> Path:
    return data_dir / "logs" / LOG_NAME


def setup(data_dir: Path) -> logging.Logger:
    """Sends the core's loggers (`agora_core.*`) to the rotating file once per data folder, and logs uncaught errors
    of background threads there too."""
    logger = logging.getLogger("agora_core")
    path = log_path(data_dir)
    with _lock:
        for handler in list(logger.handlers):
            if getattr(handler, "agora_log", None) == str(path):
                return logger
            if getattr(handler, "agora_log", None):  # another data folder (tests): only one file at a time
                logger.removeHandler(handler)
                handler.close()
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(path, maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8", delay=True)
        handler.agora_log = str(path)  # type: ignore[attr-defined]
        handler.setFormatter(_JsonLines())
        handler.setLevel(logging.INFO)
        logger.addHandler(handler)
        if logger.level == logging.NOTSET or logger.level > logging.INFO:
            logger.setLevel(logging.INFO)
        _hook_threads()
    return logger


def _hook_threads() -> None:
    if getattr(threading.excepthook, "agora_log", False):
        return
    previous = threading.excepthook

    def hook(args: threading.ExceptHookArgs) -> None:
        if args.exc_type is not SystemExit:
            name = args.thread.name if args.thread else "hilo"
            logging.getLogger("agora_core.hilos").error("Error sin controlar en %s", name, exc_info=(args.exc_type, args.exc_value, args.exc_traceback))
        previous(args)

    hook.agora_log = True  # type: ignore[attr-defined]
    threading.excepthook = hook


def record(level: str, source: str, area: str, message: str) -> None:
    """Writes one entry that did not come from a core logger (the interface's errors)."""
    numeric = {"debug": logging.DEBUG, "info": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR}.get(level, logging.INFO)
    logging.getLogger("agora_core.interfaz").log(numeric, "%s", message, extra={"source": source, "area": area})


def read(data_dir: Path, level: str | None = None, text: str | None = None, source: str | None = None, limit: int = 300) -> list[dict]:
    """Newest entries first, across the current file and the rotated ones. Broken lines are skipped."""
    path = log_path(data_dir)
    minimum = LEVELS.index(level) if level in LEVELS else 0
    needle = (text or "").strip().lower()
    found: list[dict] = []
    files = [path] + [path.with_name(f"{LOG_NAME}.{n}") for n in range(1, BACKUPS + 1)]
    for file in files:
        try:
            lines = file.read_text(encoding="utf-8", errors="replace").splitlines()
        except FileNotFoundError:
            continue
        for line in reversed(lines):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("level") not in LEVELS:
                continue
            if LEVELS.index(entry["level"]) < minimum or (source and entry.get("source") != source):
                continue
            if needle and needle not in f"{entry.get('area', '')} {entry.get('message', '')}".lower():
                continue
            found.append(entry)
            if len(found) >= limit:
                return found
    return found


def size(data_dir: Path) -> int:
    path = log_path(data_dir)
    return sum(f.stat().st_size for f in [path, *(path.with_name(f"{LOG_NAME}.{n}") for n in range(1, BACKUPS + 1))] if f.exists())

