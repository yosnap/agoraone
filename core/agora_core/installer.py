"""Installing a missing piece, only when the user confirms it (1.6): one at a time, in the background, with its
progress and last lines for the screen. What runs comes from the diagnosis's own list (a Homebrew formula or
cask, or the Whisper model), never from a command sent by anyone; nothing of Hermes is ever touched."""

import os
import shutil
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

WHISPER_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{model}.bin"
MAX_LINES = 30


class InstallError(RuntimeError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


class Installer:
    def __init__(self):
        self.lock = threading.Lock()
        self.job: dict | None = None

    def state(self) -> dict | None:
        with self.lock:
            return dict(self.job, lines=list(self.job["lines"])) if self.job else None

    def _say(self, line: str) -> None:
        with self.lock:
            self.job["lines"] = (self.job["lines"] + [line.rstrip()[:300]])[-MAX_LINES:]

    def start(self, piece: dict) -> dict:
        how = piece["how"]
        if how["kind"] not in ("brew", "model"):
            raise InstallError("Esa pieza no se puede instalar desde AgoraOne: sigue las indicaciones.")
        with self.lock:
            if self.job and self.job["state"] == "running":
                raise InstallError("Ya se está instalando otra pieza. Espera a que termine.", 409)
            self.job = {"id": piece["id"], "name": piece["name"], "state": "running", "lines": [], "done": 0, "total": how.get("bytes") or 0,
                        "started": time.time(), "error": None}
        threading.Thread(target=self._run, args=(how,), daemon=True).start()
        return self.state()

    def _finish(self, error: str | None) -> None:
        with self.lock:
            self.job["state"] = "failed" if error else "done"
            self.job["error"] = error

    def _run(self, how: dict) -> None:
        try:
            if how["kind"] == "brew":
                self._brew(how["package"])
            else:
                self._model(how["model"])
            self._finish(None)
        except InstallError as error:
            self._finish(str(error))
        except Exception:  # noqa: BLE001 - the screen says it failed; the lines show where
            self._finish("No se pudo instalar.")

    def _brew(self, package: str) -> None:
        brew = shutil.which("brew") or next((p for p in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew") if os.path.isfile(p)), None)
        if not brew:
            raise InstallError("Falta Homebrew: instálalo desde brew.sh y vuelve a intentarlo.")
        args = [brew, "install", *package.split()]  # «--cask ollama» or «ffmpeg», from the diagnosis's own list
        self._say("$ " + " ".join(["brew", "install", *package.split()]))
        env = {**os.environ, "HOMEBREW_NO_AUTO_UPDATE": "1", "NONINTERACTIVE": "1"}
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, env=env)
        for line in process.stdout:
            self._say(line)
        if process.wait() != 0:
            raise InstallError("Homebrew no pudo instalarlo: mira las últimas líneas.")

    def _model(self, model: str) -> None:
        folder = Path.home() / ".cache/whisper"
        folder.mkdir(parents=True, exist_ok=True)
        target, partial = folder / f"{model}.bin", folder / f"{model}.bin.part"
        if target.is_file():
            self._say(f"Ya está en {target}.")
            return
        self._say(f"Descargando {model} de Hugging Face a {folder}…")
        with urllib.request.urlopen(WHISPER_URL.format(model=model), timeout=60) as response:
            total = int(response.headers.get("Content-Length") or 0)
            with self.lock:
                self.job["total"] = total or self.job["total"]
            with open(partial, "wb") as file:
                while chunk := response.read(1 << 20):
                    file.write(chunk)
                    with self.lock:
                        self.job["done"] += len(chunk)
        if partial.stat().st_size < 50_000_000:
            partial.unlink(missing_ok=True)
            raise InstallError("La descarga se cortó o no es un modelo: vuelve a intentarlo.")
        partial.rename(target)
        self._say(f"Listo: {target}.")
