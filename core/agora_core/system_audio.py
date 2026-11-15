"""What the computer plays during a meeting (the others' voices in Meet, Zoom, Teams), recorded to a file
behind one interface with an adapter per system:
- macOS: `agora-system-audio`, a small ScreenCaptureKit program built from `helpers/system-audio-macos.swift`
  (permission «Grabación de pantalla y audio del sistema»; it records audio only, never the screen);
- Linux: ffmpeg reading the «monitor» of the default output in PulseAudio or PipeWire (`pactl`);
- Windows: no adapter yet, so only the microphone is recorded, and the user is told.
Nothing is sent anywhere; the file lives in AgoraOne's data."""

import os
import shutil
import signal
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

from . import transcribe

HELPER = Path(__file__).resolve().parents[1] / "helpers" / "bin" / "agora-system-audio"
READY_WAIT = 15.0
STOP_WAIT = 10.0


class SystemAudioError(RuntimeError):
    pass


@dataclass
class Capture:
    process: subprocess.Popen
    path: Path
    source: str


def adapter() -> dict:
    """Which adapter this system has: `source` (None when there is none), the file suffix and why not."""
    if sys.platform == "darwin":
        if HELPER.is_file() and os.access(HELPER, os.X_OK):
            return {"source": "macos", "suffix": ".m4a", "note": None}
        return {"source": None, "suffix": None, "note": "Falta el programa de captura del audio del Mac (se crea al empaquetar o con `pnpm helpers`, que necesita las herramientas de Xcode). Solo se grabará tu micrófono."}
    if sys.platform.startswith("linux"):
        if shutil.which("pactl") and _ffmpeg():
            return {"source": "linux-pulse", "suffix": ".mka", "note": None}
        return {"source": None, "suffix": None, "note": "Para grabar el audio del sistema en Linux hacen falta pactl (PulseAudio o PipeWire) y ffmpeg. Solo se grabará tu micrófono."}
    return {"source": None, "suffix": None, "note": "En este sistema todavía no se graba el audio del sistema: solo tu micrófono."}


def _ffmpeg() -> str | None:
    return next(iter(transcribe.find_program(transcribe.FFMPEG_NAMES)), None)


def _die_with_parent() -> None:
    """Linux: ffmpeg gets SIGTERM (and closes its file) if the core dies without stopping it."""
    import ctypes

    ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG


def _wait_ready(process: subprocess.Popen) -> str | None:
    """The helper's first line ("ready") or None if it ended or took too long."""
    line: list[bytes] = []
    reader = threading.Thread(target=lambda: line.append(process.stdout.readline()), daemon=True)
    reader.start()
    reader.join(READY_WAIT)
    return line[0].decode(errors="replace").strip() if line else None


def start(path: Path) -> Capture:
    """Starts recording what the computer plays into `path` (with the adapter's suffix). Raises
    `SystemAudioError` with a message for the user when it cannot, so the meeting goes on with the mic only."""
    found = adapter()
    if not found["source"]:
        raise SystemAudioError(found["note"])
    path = path.with_suffix(found["suffix"])
    if found["source"] == "macos":
        process = subprocess.Popen([str(HELPER), str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if _wait_ready(process) != "ready":
            if process.poll() is None:
                process.kill()
            error = process.communicate(timeout=5)[1].decode(errors="replace")
            if process.returncode == 2 or "permiso" in error:
                raise SystemAudioError("macOS no deja grabar el audio del sistema: da permiso a AgoraOne en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla y audio del sistema, y vuelve a empezar. Mientras, solo se graba tu micrófono.")
            raise SystemAudioError("No se pudo grabar el audio del sistema; solo se graba tu micrófono.")
        return Capture(process, path, "macos")
    try:
        sink = subprocess.run(["pactl", "get-default-sink"], capture_output=True, timeout=5, check=True).stdout.decode().strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise SystemAudioError("No se encuentra la salida de audio del sistema (pactl); solo se graba tu micrófono.") from error
    if not sink or any(c in sink for c in "\n\0"):
        raise SystemAudioError("No hay una salida de audio por defecto; solo se graba tu micrófono.")
    process = subprocess.Popen([_ffmpeg(), "-loglevel", "error", "-f", "pulse", "-i", f"{sink}.monitor", "-ac", "2", "-c:a", "aac", "-b:a", "96k", str(path)],
                               stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, preexec_fn=_die_with_parent)
    try:
        process.wait(1.5)
        raise SystemAudioError("No se pudo grabar el audio del sistema; solo se graba tu micrófono.")
    except subprocess.TimeoutExpired:
        return Capture(process, path, "linux-pulse")


def stop(capture: Capture) -> int:
    """Stops the recording and closes its file; the bytes recorded (0 if nothing came out)."""
    process = capture.process
    if process.poll() is None:
        try:
            if capture.source == "linux-pulse":
                process.stdin.write(b"q")  # ffmpeg's own way to finish the file
                process.stdin.flush()
            else:
                process.send_signal(signal.SIGTERM)
        except OSError:
            pass
        try:
            process.wait(STOP_WAIT)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(5)
    for pipe in (process.stdin, process.stdout, process.stderr):
        if pipe:
            pipe.close()
    try:
        return capture.path.stat().st_size
    except OSError:
        return 0
