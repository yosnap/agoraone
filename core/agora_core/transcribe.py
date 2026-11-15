"""Speech to text on this machine with whisper.cpp, for dictating in the chats and for meetings. Nothing is
sent anywhere: the audio is converted with ffmpeg (16 kHz mono WAV) and read by `whisper-cli` with a model
file the user picks. Both programs exist for macOS, Linux and Windows; they are looked for where each system
usually installs them, and the user can name them in Settings. No path of a particular user is assumed."""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from .db import transaction

SETTING = "voice"
DEFAULTS = {"binary": None, "ffmpeg": None, "model": None, "language": "auto"}
LANGUAGES = {"auto", "es", "en", "ca", "pt", "fr", "it", "de"}
WHISPER_NAMES = ("whisper-cli", "whisper-cpp", "whisper")
MAX_AUDIO = 200 * 1024 * 1024
MODEL_SUFFIX = ".bin"


class VoiceError(RuntimeError):
    pass


def _exe(name: str) -> str:
    return f"{name}.exe" if sys.platform == "win32" else name


def _program_dirs() -> list[Path]:
    """Where each system usually puts these programs, besides the PATH."""
    home = Path.home()
    if sys.platform == "darwin":
        return [Path("/opt/homebrew/bin"), Path("/usr/local/bin"), home / ".local/bin"]
    if sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local"))
        return [local / "Programs/whisper", local / "Programs/ffmpeg/bin", Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "ffmpeg/bin",
                home / "scoop/shims", Path("C:/ProgramData/chocolatey/bin")]
    return [Path("/usr/bin"), Path("/usr/local/bin"), home / ".local/bin", Path("/snap/bin"), Path("/var/lib/flatpak/exports/bin")]


def find_program(names: tuple[str, ...]) -> list[str]:
    """Every executable with one of these names on the PATH or in the usual folders, first found first."""
    found: list[str] = []
    for name in names:
        for candidate in [shutil.which(_exe(name))] + [str(d / _exe(name)) for d in _program_dirs()]:
            if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                real = os.path.realpath(candidate)
                if real not in {os.path.realpath(f) for f in found}:
                    found.append(candidate)
    return found


def _model_dirs() -> list[Path]:
    """Where whisper.cpp models usually live (its own download script, caches of tools that use it)."""
    home = Path.home()
    dirs = [home / ".cache/whisper", home / ".cache/whisper.cpp", home / "whisper.cpp/models", home / ".local/share/whisper"]
    cache = home / ".cache"
    if cache.is_dir():
        try:
            dirs += [p / "whisper" for p in cache.iterdir() if p.is_dir() and not p.is_symlink()][:50]
        except OSError:
            pass
    if sys.platform == "darwin":
        dirs += [home / "Library/Application Support/whisper", Path("/opt/homebrew/share/whisper-cpp")]
    if sys.platform == "win32":
        dirs.append(Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local")) / "whisper")
    return dirs


def find_models() -> list[dict]:
    """whisper.cpp model files (ggml-*.bin) in the usual folders, largest first: name, path and size."""
    found: dict[str, dict] = {}
    for folder in _model_dirs():
        try:
            if not folder.is_dir():
                continue
            for path in folder.glob("ggml-*.bin"):
                if path.is_file() and not path.is_symlink():
                    found[str(path.resolve())] = {"name": path.stem.removeprefix("ggml-"), "path": str(path), "bytes": path.stat().st_size}
        except OSError:
            continue
    return sorted(found.values(), key=lambda m: -m["bytes"])


def settings(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    saved = json.loads(row["value"]) if row else {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}


def _valid_file(value: str | None, program: bool) -> str | None:
    if value is None or value == "":
        return None
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise VoiceError("Esa ruta no es un archivo de este equipo.")
    if program and not os.access(path, os.X_OK):
        raise VoiceError("Ese archivo no es un programa ejecutable.")
    if not program and path.suffix != MODEL_SUFFIX:
        raise VoiceError("El modelo debe ser un archivo de whisper.cpp (ggml-….bin).")
    return str(path)


def save_settings(connection: sqlite3.Connection, changes: dict) -> dict:
    current = settings(connection)
    if "binary" in changes:
        current["binary"] = _valid_file(changes["binary"], program=True)
    if "ffmpeg" in changes:
        current["ffmpeg"] = _valid_file(changes["ffmpeg"], program=True)
    if "model" in changes:
        current["model"] = _valid_file(changes["model"], program=False)
    if "language" in changes:
        if changes["language"] not in LANGUAGES:
            raise VoiceError("Idioma no admitido.")
        current["language"] = changes["language"]
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", (SETTING, json.dumps(current)))
    return current


def resolved(connection: sqlite3.Connection) -> dict:
    """What would be used now: the chosen programs and model, or the first ones found."""
    chosen = settings(connection)
    binary = chosen["binary"] or next(iter(find_program(WHISPER_NAMES)), None)
    ffmpeg = chosen["ffmpeg"] or next(iter(find_program(("ffmpeg",))), None)
    model = chosen["model"] or next((m["path"] for m in find_models()), None)
    return {"binary": binary, "ffmpeg": ffmpeg, "model": model, "language": chosen["language"]}


def status(connection: sqlite3.Connection) -> dict:
    use = resolved(connection)
    return {**use, "chosen": settings(connection), "binaries": find_program(WHISPER_NAMES), "ffmpegs": find_program(("ffmpeg",)),
            "models": find_models(), "ready": bool(use["binary"] and use["ffmpeg"] and use["model"]), "platform": sys.platform}


def transcribe(connection: sqlite3.Connection, audio: bytes, language: str | None = None, timeout: float | None = None) -> dict:
    """The words in an audio clip (any format ffmpeg reads), with their times. Local only."""
    use = resolved(connection)
    if not use["binary"]:
        raise VoiceError("No se encuentra whisper.cpp (whisper-cli). Instálalo o indica dónde está en Ajustes › Voz.")
    if not use["ffmpeg"]:
        raise VoiceError("No se encuentra ffmpeg. Instálalo o indica dónde está en Ajustes › Voz.")
    if not use["model"]:
        raise VoiceError("Falta el modelo de Whisper. Elige un archivo ggml-….bin en Ajustes › Voz.")
    if not audio or len(audio) > MAX_AUDIO:
        raise VoiceError("El audio está vacío o es demasiado grande.")
    language = language or use["language"]
    if language not in LANGUAGES:
        language = "auto"
    with tempfile.TemporaryDirectory(prefix="agora-voz-") as work:
        source, wav, out = Path(work) / "entrada", Path(work) / "audio.wav", Path(work) / "salida"
        source.write_bytes(audio)
        converted = subprocess.run([use["ffmpeg"], "-nostdin", "-loglevel", "error", "-y", "-i", str(source), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)],
                                   capture_output=True, timeout=120, check=False)
        if converted.returncode != 0 or not wav.is_file():
            raise VoiceError("No se pudo leer ese audio.")
        seconds = max(1.0, (wav.stat().st_size - 44) / 32000)
        try:
            done = subprocess.run([use["binary"], "-m", use["model"], "-f", str(wav), "-l", language, "-oj", "-of", str(out), "-np"],
                                  capture_output=True, timeout=timeout or 60 + seconds * 3, check=False)
        except subprocess.TimeoutExpired as error:
            raise VoiceError("La transcripción tardó demasiado.") from error
        result = Path(f"{out}.json")
        if done.returncode != 0 or not result.is_file():
            raise VoiceError("Whisper no pudo transcribir el audio. Comprueba el modelo en Ajustes › Voz.")
        data = json.loads(result.read_text(encoding="utf-8", errors="replace"))
    segments = [{"start": s.get("offsets", {}).get("from", 0) / 1000, "end": s.get("offsets", {}).get("to", 0) / 1000, "text": (s.get("text") or "").strip()}
                for s in data.get("transcription", []) if (s.get("text") or "").strip()]
    return {"text": " ".join(s["text"] for s in segments).strip(), "segments": segments,
            "language": (data.get("result") or {}).get("language"), "seconds": round(seconds, 1)}
