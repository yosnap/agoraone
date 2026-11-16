"""Watson's voice (1.7): which engine speaks its answers and with which voice.
- macOS: the system's own voices, spoken by the screen itself (nothing goes through the core);
- VoiceStudio: a local voice studio (OmniVoice) on this Mac, at a fixed loopback address, asked through its
  OpenAI-compatible route. The text goes to that app on this machine and nowhere else, so any answer can use it.
«auto» uses the VoiceStudio profile named «Watson (AgoraOne)» when VoiceStudio is open and has it, else macOS.
The address is fixed here, never taken from the client or the settings, so the core cannot be pointed anywhere else."""

import json
import sqlite3

import httpx

from .db import transaction

VOICESTUDIO = "http://127.0.0.1:3900"
WATSON_PROFILE = "Watson (AgoraOne)"
ENGINES = ("auto", "macos", "voicestudio")
DEFAULTS = {"engine": "auto", "voice": None, "speed": 1.0, "macVoice": None}
MAX_TEXT = 400  # one piece: the screen sends an answer sentence by sentence


class TtsError(RuntimeError):
    pass


def settings(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT value FROM setting WHERE key = 'voice.tts'").fetchone()
    saved = json.loads(row["value"]) if row else {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}


def save_settings(connection: sqlite3.Connection, changes: dict) -> dict:
    merged = {**settings(connection), **{k: v for k, v in changes.items() if k in DEFAULTS}}
    if merged["engine"] not in ENGINES:
        raise TtsError("Motor de voz desconocido.")
    for key in ("voice", "macVoice"):
        if merged[key] is not None and (not isinstance(merged[key], str) or not 0 < len(merged[key]) <= 120):
            raise TtsError("Voz no válida.")
    if not isinstance(merged["speed"], (int, float)) or not 0.5 <= merged["speed"] <= 2:
        raise TtsError("La velocidad va de 0,5 a 2.")
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES ('voice.tts', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                           (json.dumps(merged),))
    return merged


def voicestudio_voices() -> list[dict] | None:
    """VoiceStudio's voice profiles, or None when it is not open."""
    try:
        answer = httpx.get(f"{VOICESTUDIO}/profiles", timeout=2.5)
        answer.raise_for_status()
        profiles = answer.json()
    except (httpx.HTTPError, ValueError):
        return None
    return [{"id": str(p["id"]), "name": str(p.get("name") or p["id"]), "language": p.get("language") or None}
            for p in profiles if isinstance(p, dict) and p.get("id")][:100]


def resolve(chosen: dict, voices: list[dict] | None) -> dict:
    """What speaks now: the engine and voice the screen should use, and why when it is not the chosen one."""
    engine, voice, problem = chosen["engine"], chosen["voice"], None
    if engine == "auto":
        watson = next((v for v in voices or [] if v["name"] == WATSON_PROFILE), None)
        engine, voice = ("voicestudio", watson["id"]) if watson else ("macos", None)
    elif engine == "voicestudio":
        if voices is None:
            engine, problem = "macos", "VoiceStudio no está abierto: Watson habla con la voz de macOS."
        elif not any(v["id"] == voice for v in voices):
            engine, problem = "macos", "Esa voz ya no está en VoiceStudio: Watson habla con la voz de macOS."
    return {"engine": engine, "voice": voice if engine == "voicestudio" else None, "speed": chosen["speed"],
            "macVoice": chosen["macVoice"], "problem": problem}


def synthesize(voice: str, text: str) -> bytes:
    """One piece of an answer, spoken by VoiceStudio with that voice profile: WAV bytes."""
    text = " ".join((text or "").split())[:MAX_TEXT]
    if not text or not voice:
        raise TtsError("Nada que decir.")
    body = {"model": "omnivoice", "voice": voice, "input": text, "language": "es", "response_format": "wav",
            # The profile's reference is already clean: preparing it again each time only adds seconds.
            "denoise": False, "preprocess_prompt": False}
    try:
        answer = httpx.post(f"{VOICESTUDIO}/v1/audio/speech", json=body, timeout=60)
    except httpx.HTTPError as error:
        raise TtsError("VoiceStudio no responde.") from error
    if answer.status_code != 200 or not answer.headers.get("content-type", "").startswith("audio/"):
        raise TtsError("VoiceStudio no pudo decirlo.")
    return answer.content
