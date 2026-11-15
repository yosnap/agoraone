"""Local speech to text: programs and models found or chosen, settings checked, and a clip transcribed by
whisper.cpp through ffmpeg — here with stand-in programs, so the test needs neither installed."""

import json
import os
import stat
import sys

import pytest
from fastapi.testclient import TestClient

from agora_core import transcribe
from agora_core.app import SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings
from tests.test_fiscal_excel import MemorySecrets

SECRET, OWNER = "a" * 64, "b" * 64
pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="los programas de prueba son guiones de shell")


def _program(path, body):
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


@pytest.fixture
def tools(tmp_path):
    # ffmpeg: copies its input (sixth argument, after -i) to its output (the last one); whisper-cli: writes the JSON whisper.cpp writes.
    ffmpeg = _program(tmp_path / "ffmpeg", 'for last; do :; done\ncat "$6" > "$last"\n')
    result = {"result": {"language": "es"}, "transcription": [
        {"offsets": {"from": 0, "to": 2460}, "text": " Hola, esto es una prueba."}, {"offsets": {"from": 2460, "to": 3000}, "text": " "}]}
    whisper = _program(tmp_path / "whisper-cli", f'while [ "$1" != "-of" ]; do shift; done\ncat > "$2.json" <<\'FIN\'\n{json.dumps(result)}\nFIN\n')
    model = tmp_path / "ggml-prueba.bin"
    model.write_bytes(b"modelo")
    return ffmpeg, whisper, str(model)


def test_dictado_local_con_los_programas_elegidos(tmp_path, tools):
    ffmpeg, whisper, model = tools
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets())
    headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/voice/settings", json={"model": str(tmp_path / "no-existe.bin")}, headers=headers).status_code == 422
        assert client.put("/voice/settings", json={"model": ffmpeg}, headers=headers).status_code == 422, "un modelo es un ggml-….bin"
        assert client.put("/voice/settings", json={"language": "klingon"}, headers=headers).status_code == 422
        chosen = client.put("/voice/settings", json={"binary": whisper, "ffmpeg": ffmpeg, "model": model, "language": "es"}, headers=headers).json()
        assert chosen == {"binary": whisper, "ffmpeg": ffmpeg, "model": model, "language": "es"}
        state = client.get("/voice/status", headers=headers).json()
        assert state["ready"] and state["binary"] == whisper and state["platform"] == sys.platform
        heard = client.post("/voice/transcribe", content=b"audio de prueba", headers={**headers, "content-type": "audio/webm"}).json()
        assert heard["text"] == "Hola, esto es una prueba." and heard["language"] == "es"
        assert heard["segments"] == [{"start": 0.0, "end": 2.46, "text": "Hola, esto es una prueba."}]
        too_long = client.post("/voice/transcribe", content=b"x" * (1024 * 1024 + 1), headers=headers)
        assert too_long.status_code == 413


def test_sin_whisper_lo_dice(tmp_path, monkeypatch):
    from agora_core.db import DB_NAME, connect, migrate

    monkeypatch.setattr(transcribe, "find_program", lambda names: [])
    monkeypatch.setattr(transcribe, "find_models", lambda: [])
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    assert transcribe.status(connection)["ready"] is False
    with pytest.raises(transcribe.VoiceError, match="whisper"):
        transcribe.transcribe(connection, b"audio")
    connection.close()


def test_busca_modelos_en_las_caches_habituales(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.Path, "home", lambda: tmp_path)
    (tmp_path / ".cache/una-herramienta/whisper").mkdir(parents=True)
    (tmp_path / ".cache/una-herramienta/whisper/ggml-large-v3-turbo.bin").write_bytes(b"x" * 10)
    (tmp_path / ".cache/whisper").mkdir(parents=True)
    (tmp_path / ".cache/whisper/ggml-base.bin").write_bytes(b"x")
    assert [m["name"] for m in transcribe.find_models()] == ["large-v3-turbo", "base"], "el más grande primero"
