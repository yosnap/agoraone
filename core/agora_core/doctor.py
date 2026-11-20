"""«Qué tengo instalado» (1.6): every piece AgoraOne can use, whether it is here, which modules need it and how
to get it on this system. Looking changes nothing and opens nothing: it reads paths, programs on the PATH and
local servers only. Installing is a separate, confirmed step."""

import os
import shutil
import sqlite3
import sys
from pathlib import Path

from . import local_model, music_library, system_audio, transcribe
from . import system_words

HOME = Path.home()
MAC, LINUX, WINDOWS = sys.platform == "darwin", sys.platform.startswith("linux"), sys.platform == "win32"


def _app(*names: str) -> bool:
    """A macOS app in the Applications folders (never opened)."""
    return MAC and any((root / f"{name}.app").exists() for name in names for root in (Path("/Applications"), HOME / "Applications"))


def _hermes_root() -> Path:
    """Where Hermes keeps its data, by the server's rule: AGORA_HERMES_HOME, else HERMES_HOME (taken back to the
    data root when it points at one profile), else ~/.hermes."""
    agora, hermes = os.environ.get("AGORA_HERMES_HOME"), os.environ.get("HERMES_HOME")
    root = Path(os.path.expanduser(agora or hermes or str(HOME / ".hermes")))
    if not agora and root.parent.name == "profiles":
        root = root.parent.parent
    return root


def _obsidian_registry() -> Path:
    """Obsidian's list of vaults, where Obsidian keeps it on each system."""
    if MAC:
        return HOME / "Library/Application Support/obsidian/obsidian.json"
    if WINDOWS:
        return Path(os.environ.get("APPDATA") or HOME / "AppData/Roaming") / "obsidian/obsidian.json"
    return Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config") / "obsidian/obsidian.json"


def _program(*names: str) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def _how(brew: str | None = None, linux: str | None = None, windows: str | None = None, url: str | None = None) -> dict:
    """How to get it here: a Homebrew formula or cask on macOS (installable from AgoraOne), else a command or a page."""
    if MAC and brew:
        return {"kind": "brew", "package": brew, "command": f"brew install {brew}"}
    if LINUX and linux:
        return {"kind": "command", "command": linux}
    if WINDOWS and windows:
        return {"kind": "command", "command": windows}
    return {"kind": "page", "url": url} if url else {"kind": "none"}


def check(connection: sqlite3.Connection, has_anthropic_key: bool, has_zernio_key: bool = False, has_typesafe_key: bool = False) -> dict:
    voice = transcribe.status(connection)
    local = local_model.detect()
    pieces = []

    def add(ident, name, ok, modules, detail, how=None, optional=False):
        pieces.append({"id": ident, "name": name, "state": "ok" if ok else "optional" if optional else "missing",
                       "modules": modules, "detail": detail, "how": how or {"kind": "none"}})

    hermes_root = _hermes_root()
    hermes = hermes_root.is_dir()
    shown = "~/.hermes" if hermes_root == HOME / ".hermes" else str(hermes_root)
    add("hermes", "Hermes", hermes, ["Oficina 3D", "Trabajos", "Conectores"],
        f"Perfiles, bots y kanban detectados en {shown}." if hermes else f"No se encuentra {shown}: sin perfiles ni bots.",
        _how(url="https://github.com/NousResearch/hermes-agent"), optional=True)
    obsidian = _obsidian_registry().is_file()
    add("obsidian", "Obsidian y sus vaults", obsidian, ["Cerebro", "Reuniones"],
        "Registro de vaults encontrado." if obsidian else "Sin registro de Obsidian: el Cerebro no tiene notas que indexar.",
        _how(brew="--cask obsidian", url="https://obsidian.md/download"))
    claude = _program("claude")
    add("claude-code", "Claude Code", bool(claude), ["Watson", "Correo", "Reuniones", "Fiscal"],
        "Tu sesión de Claude Code: Watson, resúmenes y lectura de facturas sin clave de API." if claude else "No está: Watson necesitará una clave de API.",
        _how(brew="--cask claude-code", linux="curl -fsSL https://claude.ai/install.sh | bash", url="https://docs.anthropic.com/claude-code"))
    add("anthropic-key", "Clave de API de Anthropic", has_anthropic_key, ["Watson"],
        f"Guardada en el {system_words.KEYSTORE} (reserva si no hay Claude Code)." if has_anthropic_key else "Opcional si tienes Claude Code. Se guarda en Ajustes › Asistente.",
        optional=True)
    add("whisper", "whisper.cpp (whisper-cli)", bool(voice["binary"]), ["Voz", "Reuniones"],
        voice["binary"] or "Sin él no se puede dictar ni transcribir reuniones.", _how(brew="whisper-cpp", linux="sudo apt install whisper-cpp", windows="winget install ggerganov.whisper.cpp"))
    add("whisper-model", "Modelo de Whisper", bool(voice["model"]), ["Voz", "Reuniones"],
        Path(voice["model"]).name if voice["model"] else "Falta un modelo ggml-….bin (se recomienda large-v3-turbo, unos 1,6 GB).",
        {"kind": "model", "model": "ggml-large-v3-turbo", "bytes": 1_620_000_000})
    add("ffmpeg", "ffmpeg", bool(voice["ffmpeg"]), ["Voz", "Reuniones"], voice["ffmpeg"] or "Convierte el audio para Whisper.",
        _how(brew="ffmpeg", linux="sudo apt install ffmpeg", windows="winget install Gyan.FFmpeg"))
    capture = system_audio.adapter()
    add("system-audio", "Audio del sistema en reuniones", bool(capture["source"]), ["Reuniones"],
        "Se graba lo que suena en el ordenador." if capture["source"] else capture["note"], optional=True)
    ollama = bool(_program("ollama")) or _app("Ollama")
    add("ollama", "Ollama", ollama, ["Reuniones privadas"],
        ("Abierto ahora." if local and "11434" in local else "Instalado, pero cerrado.") if ollama else "Modelo local para resumir lo que no sale del equipo.",
        _how(brew="--cask ollama", linux="curl -fsSL https://ollama.com/install.sh | sh", windows="winget install Ollama.Ollama"), optional=True)
    lmstudio = _app("LM Studio") or (HOME / ".lmstudio/bin/lms").is_file()
    add("lmstudio", "LM Studio", lmstudio, ["Reuniones privadas"], "Alternativa a Ollama." if not lmstudio else "Instalado.",
        _how(brew="--cask lm-studio", url="https://lmstudio.ai"), optional=True)
    from .orca_launch import binary as orca_binary

    orca = orca_binary()
    add("orca", "Orca", bool(orca), ["Orca"], "Lanza Claude Code o Codex en el repositorio de un proyecto." if orca else "Para llevar encargos a un agente en tus repositorios.",
        optional=True)
    add("zernio", "WhatsApp (Zernio)", has_zernio_key, ["WhatsApp"],
        f"Clave de API de Zernio guardada en el {system_words.KEYSTORE}." if has_zernio_key else "Para leer tu WhatsApp: guarda la clave de Zernio en Ajustes › WhatsApp.",
        _how(url="https://zernio.com"), optional=True)
    add("typesafe", "Jev (TypeSafe)", has_typesafe_key, ["Jev"],
        f"Clave de API de TypeSafe guardada en el {system_words.KEYSTORE}." if has_typesafe_key else "Para que Jev ayude a decidir: guarda la clave de TypeSafe en Ajustes › Jev.",
        _how(url="https://console.typesafe.ai/keys"), optional=True)
    library = music_library.folders(connection)
    add("music-folder", "Carpeta de música", bool(library), ["Música"], ", ".join(library) if library else "Elígela en Ajustes › Voz › Tu música.", optional=True)
    if LINUX:
        add("playerctl", "playerctl (MPRIS)", bool(_program("playerctl")), ["Música"], "Controla los reproductores en Linux.", _how(linux="sudo apt install playerctl"))
    wake = (Path(__file__).resolve().parents[1] / "helpers/bin/agora-wake").is_file()
    add("wake", "«Oye Watson»", wake and MAC, ["Voz"], "Reconocimiento de voz de Apple en el equipo." if wake and MAC else ("Solo en la app de escritorio del Mac." if MAC else "Todavía no está disponible en este sistema: llama a Watson con Ctrl+Alt+W."), optional=True)
    add("brew", "Homebrew", bool(_program("brew")), ["Instalador"], "Con él AgoraOne puede instalar las piezas por ti." if _program("brew") else "Sin él, cada pieza se instala a mano.",
        {"kind": "page", "url": "https://brew.sh"} if MAC else {"kind": "none"}, optional=not MAC)
    for ident, name, programs, apps in (("codex", "Codex (OpenAI)", ("codex",), ()), ("gemini", "Gemini CLI", ("gemini",), ()),
                                        ("opencode", "OpenCode", ("opencode",), ()), ("cursor", "Cursor", ("cursor",), ("Cursor",))):
        here = bool(_program(*programs)) or _app(*apps)
        add(ident, name, here, ["Compatibilidad (próximamente)"], "Detectado: AgoraOne podrá usarlo como motor o conectarle el cerebro." if here else "No instalado.", optional=True)
    missing = [p for p in pieces if p["state"] == "missing"]
    return {"pieces": pieces, "platform": sys.platform, "missing": len(missing),
            "summary": "Todo lo necesario está instalado." if not missing else f"Faltan {len(missing)} piezas necesarias para algún módulo."}
