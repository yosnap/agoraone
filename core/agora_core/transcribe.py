"""Speech to text on this machine with whisper.cpp, for dictating in the chats and for meetings. Nothing is
sent anywhere: the audio is converted with ffmpeg (16 kHz mono WAV) and read by `whisper-cli` with a model
file the user picks. Both programs exist for macOS, Linux and Windows; they are looked for where each system
usually installs them, and the user can name them in Settings. No path of a particular user is assumed."""

import itertools
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from .db import transaction

SETTING = "voice"
DEFAULTS = {"binary": None, "ffmpeg": None, "model": None, "language": "auto"}
LANGUAGES = {"auto", "es", "en", "ca", "pt", "fr", "it", "de"}
# Looked for on their own; `whisper` (often the Python tool, with other arguments) and `main` (old builds)
# are only accepted when the user names them and the program answers like whisper.cpp.
WHISPER_FOUND = ("whisper-cli", "whisper-cpp")
WHISPER_NAMES = WHISPER_FOUND + ("whisper", "main")
FFMPEG_NAMES = ("ffmpeg",)
MAX_AUDIO = 200 * 1024 * 1024
MODEL_SUFFIX = ".bin"
DICTATION_SECONDS = 65
WHISPER_CAP = 85.0  # with ffmpeg's few seconds, always under the server's 120 s wait for the core
FFMPEG_TIMEOUT = 30.0
FORMATS = "matroska,webm,mov,mp4,m4a,ogg,wav,mp3"  # what a recording can be; never playlists that open other files
SEARCH_TTL = 60.0

_busy = threading.Lock()
_search: dict = {}


class VoiceError(RuntimeError):
    pass


class VoiceBusy(VoiceError):
    pass


def _exe(name: str) -> str:
    return f"{name}.exe" if sys.platform == "win32" else name


def _hidden() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def _program_dirs() -> list[Path]:
    """Where each system usually puts these programs, besides the PATH."""
    home = Path.home()
    if sys.platform == "darwin":
        return [Path("/opt/homebrew/bin"), Path("/usr/local/bin"), Path("/opt/local/bin"), home / ".local/bin"]
    if sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local"))
        return [local / "Programs/whisper", local / "Programs/ffmpeg/bin", local / "Microsoft/WinGet/Links",
                Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "ffmpeg/bin", home / "scoop/shims", Path("C:/ProgramData/chocolatey/bin")]
    # Snap's ffmpeg cannot see the system's temporary folder and Flatpak exports apps by id, so neither is looked in.
    return [Path("/usr/bin"), Path("/usr/local/bin"), home / ".local/bin"]


def _named(path: Path, names: tuple[str, ...]) -> bool:
    if sys.platform == "win32":
        return path.suffix.lower() == ".exe" and path.stem.lower() in names
    return path.name in names


def _runnable(path: Path, names: tuple[str, ...]) -> bool:
    """A real program with one of these names: on Windows only an .exe (a .bat or .cmd would go through cmd.exe)."""
    if not path.is_absolute() or not path.is_file() or not _named(path, names):
        return False
    if sys.platform != "win32" and not os.access(path, os.X_OK):
        return False
    return not (sys.platform.startswith("linux") and str(path).startswith("/snap/"))


def _search_programs(names: tuple[str, ...]) -> list[str]:
    found: list[str] = []
    for name in names:
        for candidate in [shutil.which(_exe(name))] + [str(d / _exe(name)) for d in _program_dirs()]:
            try:
                if candidate and _runnable(Path(candidate), names) and os.path.realpath(candidate) not in {os.path.realpath(f) for f in found}:
                    found.append(candidate)
            except OSError:
                continue
    return found


def _model_dirs() -> list[tuple[Path, Path]]:
    """Where whisper.cpp models usually live, each with the tree its links may point into."""
    home = Path.home()
    dirs = [home / ".cache/whisper", home / ".cache/whisper.cpp", home / "whisper.cpp/models", home / ".local/share/whisper"]
    cache = home / ".cache"
    try:
        if cache.is_dir():
            dirs += [p / "whisper" for p in itertools.islice(cache.iterdir(), 200) if p.is_dir() and not p.is_symlink() and not p.is_junction()]
    except OSError:
        pass
    if sys.platform == "darwin":
        dirs += [home / "Library/Application Support/whisper", Path("/opt/homebrew/share/whisper-cpp"), Path("/usr/local/share/whisper-cpp")]
    if sys.platform == "win32":
        dirs.append(Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local")) / "whisper")
    pairs = [(d, d) for d in dirs]
    hub = home / ".cache/huggingface/hub/models--ggerganov--whisper.cpp"
    try:
        if hub.is_dir():
            pairs += [(snapshot, hub) for snapshot in itertools.islice((hub / "snapshots").iterdir(), 20)]
    except OSError:
        pass
    return pairs


def _search_models() -> list[dict]:
    found: dict[str, dict] = {}
    for folder, tree in _model_dirs():
        try:
            if not folder.is_dir():
                continue
            for path in itertools.islice(folder.glob("ggml-*.bin"), 50):
                real = path.resolve()
                if path.is_file() and (not (path.is_symlink() or path.is_junction()) or real.is_relative_to(tree.resolve())):
                    found[str(real)] = {"name": path.stem.removeprefix("ggml-"), "path": str(path), "bytes": real.stat().st_size}
        except (OSError, ValueError):
            continue
    return sorted(found.values(), key=lambda m: -m["bytes"])


def _cached(key: str, search):
    now = time.monotonic()
    hit = _search.get(key)
    if hit and now - hit[0] < SEARCH_TTL:
        return hit[1]
    value = search()
    _search[key] = (now, value)
    return value


def forget_search() -> None:
    _search.clear()


def find_program(names: tuple[str, ...]) -> list[str]:
    """Every program with one of these names on the PATH or in the usual folders, first found first."""
    return _cached("programs:" + ",".join(names), lambda: _search_programs(names))


def find_models() -> list[dict]:
    """whisper.cpp model files (ggml-*.bin) in the usual folders, largest first: name, path and size."""
    return _cached("models", _search_models)


def preferred_model(models: list[dict]) -> str | None:
    """turbo when there is one (large quality, a fraction of the time), else the largest."""
    turbo = next((m for m in models if "turbo" in m["name"]), None)
    return (turbo or next(iter(models), {})).get("path")


def settings(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    saved = json.loads(row["value"]) if row else {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}


def _answers(program: str, args: list[str], sign: tuple[str, ...]) -> bool:
    """Whether the program, run with these arguments for a moment, prints one of these signs."""
    try:
        done = subprocess.run([program, *args], capture_output=True, timeout=5, check=False, stdin=subprocess.DEVNULL, **_hidden())
    except (OSError, subprocess.TimeoutExpired):
        return False
    printed = (done.stdout + done.stderr).decode("utf-8", errors="replace")
    return any(s in printed for s in sign)


def _valid_program(value: str | None, names: tuple[str, ...], kind: str) -> str | None:
    if value is None or value == "":
        return None
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise VoiceError("Esa ruta no es un archivo de este equipo.")
    if not _runnable(path, names):
        if sys.platform.startswith("linux") and str(path).startswith("/snap/"):
            raise VoiceError("El ffmpeg de Snap no puede leer los archivos temporales: instálalo con el gestor de paquetes del sistema.")
        raise VoiceError(f"Ese archivo no es {kind} ({', '.join(_exe(n) for n in names)}).")
    if kind == "whisper.cpp" and not _answers(str(path), ["--help"], ("--output-json", "-oj")):
        raise VoiceError("Ese programa no responde como whisper.cpp (whisper-cli).")
    if kind == "ffmpeg" and not _answers(str(path), ["-version"], ("ffmpeg version",)):
        raise VoiceError("Ese programa no responde como ffmpeg.")
    return str(path)


def _valid_model(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise VoiceError("Esa ruta no es un archivo de este equipo.")
    if path.suffix != MODEL_SUFFIX:
        raise VoiceError("El modelo debe ser un archivo de whisper.cpp (ggml-….bin).")
    return str(path)


def save_settings(connection: sqlite3.Connection, changes: dict) -> dict:
    current = settings(connection)
    if "binary" in changes:
        current["binary"] = _valid_program(changes["binary"], WHISPER_NAMES, "whisper.cpp")
    if "ffmpeg" in changes:
        current["ffmpeg"] = _valid_program(changes["ffmpeg"], FFMPEG_NAMES, "ffmpeg")
    if "model" in changes:
        current["model"] = _valid_model(changes["model"])
    if "language" in changes:
        if changes["language"] not in LANGUAGES:
            raise VoiceError("Idioma no admitido.")
        current["language"] = changes["language"]
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", (SETTING, json.dumps(current)))
    forget_search()
    return current


def _still(value: str | None, check) -> str | None:
    """A chosen path only while it is still there and still valid (programs get uninstalled or upgraded)."""
    try:
        return value if value and check(Path(value)) else None
    except OSError:
        return None


def resolved(connection: sqlite3.Connection) -> dict:
    """What would be used now: the chosen programs and model while they exist, or else the first ones found.
    `missing` names what was chosen and is gone, so Settings can say it instead of claiming to be ready."""
    chosen = settings(connection)
    binary = _still(chosen["binary"], lambda p: _runnable(p, WHISPER_NAMES))
    ffmpeg = _still(chosen["ffmpeg"], lambda p: _runnable(p, FFMPEG_NAMES))
    model = _still(chosen["model"], lambda p: p.is_file() and p.suffix == MODEL_SUFFIX)
    missing = [k for k, v in (("binary", binary), ("ffmpeg", ffmpeg), ("model", model)) if chosen[k] and not v]
    return {"binary": binary or (None if chosen["binary"] else next(iter(find_program(WHISPER_FOUND)), None)),
            "ffmpeg": ffmpeg or (None if chosen["ffmpeg"] else next(iter(find_program(FFMPEG_NAMES)), None)),
            "model": model or (None if chosen["model"] else preferred_model(find_models())),
            "language": chosen["language"], "missing": missing}


def status(connection: sqlite3.Connection) -> dict:
    use = resolved(connection)
    return {**use, "chosen": settings(connection), "binaries": find_program(WHISPER_FOUND), "ffmpegs": find_program(FFMPEG_NAMES),
            "models": find_models(), "ready": bool(use["binary"] and use["ffmpeg"] and use["model"]), "platform": sys.platform}


GONE = {"binary": "El whisper.cpp elegido ya no está (¿se desinstaló o actualizó?). Elígelo de nuevo en Ajustes › Voz.",
        "ffmpeg": "El ffmpeg elegido ya no está (¿se desinstaló o actualizó?). Elígelo de nuevo en Ajustes › Voz.",
        "model": "El modelo elegido ya no está. Elige otro en Ajustes › Voz."}


def _segments(data) -> tuple[list[dict], str | None]:
    if not isinstance(data, dict):
        raise TypeError("not an object")
    segments = []
    for s in data.get("transcription") or []:
        text = (s.get("text") or "").strip()
        if text:
            offsets = s.get("offsets") or {}
            segments.append({"start": (offsets.get("from") or 0) / 1000, "end": (offsets.get("to") or 0) / 1000, "text": text})
    return segments, (data.get("result") or {}).get("language")


def _gentle() -> dict:
    """Background work (meetings) at low priority and with half the cores, so the computer stays usable."""
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS}
    return {"preexec_fn": lambda: os.nice(10)}


def transcribe(connection: sqlite3.Connection, audio: bytes, language: str | None = None, timeout: float | None = None,
               max_seconds: int | None = DICTATION_SECONDS, background: bool = False) -> dict:
    """The words in an audio clip (a recording ffmpeg reads), with their times. Local only, one at a time:
    a second call while one runs gets `VoiceBusy`. Dictation keeps the first `max_seconds` and finishes
    before the server stops waiting; longer work (meetings) passes its own limits."""
    use = resolved(connection)
    for key in use["missing"]:
        raise VoiceError(GONE[key])
    if not use["binary"]:
        raise VoiceError("No se encuentra whisper.cpp (whisper-cli). Instálalo o indica dónde está en Ajustes › Voz.")
    if not use["ffmpeg"]:
        raise VoiceError("No se encuentra ffmpeg. Instálalo o indica dónde está en Ajustes › Voz.")
    if not use["model"]:
        raise VoiceError("Falta el modelo de Whisper. Elige un archivo ggml-….bin en Ajustes › Voz.")
    if not audio or len(audio) > MAX_AUDIO:
        raise VoiceError("El audio está vacío o es demasiado grande.")
    language = language if language in LANGUAGES else use["language"]
    if language not in LANGUAGES:
        language = "auto"
    if not _busy.acquire(blocking=False):
        raise VoiceBusy("Ya hay una transcripción en curso. Espera a que termine.")
    try:
        return _run(use, audio, language, timeout, max_seconds, background)
    finally:
        _busy.release()


def _run(use: dict, audio: bytes, language: str, timeout: float | None, max_seconds: int | None, background: bool = False) -> dict:
    spawn = _gentle() if background else _hidden()
    threads = ["-t", str(max(2, (os.cpu_count() or 4) // 2))] if background else []
    with tempfile.TemporaryDirectory(prefix="agora-voz-", ignore_cleanup_errors=True) as work:
        source, wav, out = Path(work) / "entrada", Path(work) / "audio.wav", Path(work) / "salida"
        source.write_bytes(audio)
        limit = ["-t", str(max_seconds)] if max_seconds else []
        try:
            converted = subprocess.run([use["ffmpeg"], "-nostdin", "-loglevel", "error", "-y", "-format_whitelist", FORMATS, "-protocol_whitelist", "file",
                                        "-i", str(source), *limit, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)],
                                       capture_output=True, timeout=FFMPEG_TIMEOUT if max_seconds else None, check=False, stdin=subprocess.DEVNULL, **spawn)
        except subprocess.TimeoutExpired as error:
            raise VoiceError("ffmpeg tardó demasiado en leer el audio.") from error
        except OSError as error:
            raise VoiceError("No se pudo ejecutar ffmpeg. Comprueba la ruta en Ajustes › Voz.") from error
        if converted.returncode != 0 or not wav.is_file():
            raise VoiceError("No se pudo leer ese audio.")
        seconds = max(1.0, (wav.stat().st_size - 44) / 32000)
        wait = timeout or min(60 + seconds * 3, WHISPER_CAP)
        try:
            done = subprocess.run([use["binary"], "-m", use["model"], "-f", str(wav), "-l", language, "-oj", "-of", str(out), "-np", *threads],
                                  capture_output=True, timeout=wait, check=False, stdin=subprocess.DEVNULL, **spawn)
        except subprocess.TimeoutExpired as error:
            raise VoiceError("La transcripción tardó demasiado. Prueba con un modelo más pequeño (turbo o base).") from error
        except OSError as error:
            raise VoiceError("No se pudo ejecutar whisper.cpp. Comprueba la ruta en Ajustes › Voz.") from error
        result = Path(f"{out}.json")
        if done.returncode != 0 or not result.is_file():
            raise VoiceError("Whisper no pudo transcribir el audio. Comprueba el modelo en Ajustes › Voz.")
        try:
            segments, heard = _segments(json.loads(result.read_text(encoding="utf-8", errors="replace")))
        except (ValueError, AttributeError, TypeError) as error:
            raise VoiceError("Whisper devolvió un resultado que no se entiende.") from error
    return {"text": " ".join(s["text"] for s in segments).strip(), "segments": segments, "language": heard, "seconds": round(seconds, 1)}
