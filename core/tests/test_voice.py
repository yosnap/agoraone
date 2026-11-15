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


@pytest.fixture(autouse=True)
def fresh_search():
    transcribe.forget_search()
    yield
    transcribe.forget_search()


FFMPEG = '[ "$1" = "-version" ] && { echo "ffmpeg version 7"; exit 0; }\nfor last; do :; done\nwhile [ "$1" != "-i" ]; do shift; done\ncat "$2" > "$last"\n'


def _whisper(path, json_text):
    return _program(path, f'[ "$1" = "--help" ] && {{ echo "  -oj, --output-json"; exit 0; }}\nwhile [ "$1" != "-of" ]; do shift; done\ncat > "$2.json" <<\'FIN\'\n{json_text}\nFIN\n')


@pytest.fixture
def tools(tmp_path):
    # ffmpeg: copies its input (after -i) to its output (the last argument); whisper-cli: writes the JSON whisper.cpp writes.
    ffmpeg = _program(tmp_path / "ffmpeg", FFMPEG)
    result = {"result": {"language": "es"}, "transcription": [
        {"offsets": {"from": 0, "to": 2460}, "text": " Hola, esto es una prueba."}, {"offsets": {"from": 2460, "to": 3000}, "text": " "}]}
    whisper = _whisper(tmp_path / "whisper-cli", json.dumps(result))
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


def _connection(tmp_path):
    from agora_core.db import DB_NAME, connect, migrate

    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    return connection


def test_lo_elegido_que_desaparece_no_se_da_por_bueno(tmp_path, tools, monkeypatch):
    ffmpeg, whisper, model = tools
    monkeypatch.setattr(transcribe, "find_program", lambda names: [])
    connection = _connection(tmp_path)
    transcribe.save_settings(connection, {"binary": whisper, "ffmpeg": ffmpeg, "model": model})
    os.remove(whisper)
    state = transcribe.status(connection)
    assert state["ready"] is False and state["missing"] == ["binary"]
    with pytest.raises(transcribe.VoiceError, match="ya no está"):
        transcribe.transcribe(connection, b"audio")
    connection.close()


def test_fallos_de_los_programas_son_errores_claros(tmp_path, tools):
    ffmpeg, whisper, model = tools
    connection = _connection(tmp_path)
    transcribe.save_settings(connection, {"binary": whisper, "ffmpeg": ffmpeg, "model": model})
    _program(tmp_path / "ffmpeg", '[ "$1" = "-version" ] && { echo "ffmpeg version 7"; exit 0; }\nexit 1\n')
    with pytest.raises(transcribe.VoiceError, match="leer ese audio"):
        transcribe.transcribe(connection, b"audio")
    _program(tmp_path / "ffmpeg", FFMPEG)
    _whisper(tmp_path / "whisper-cli", '{"transcription": [ roto')
    with pytest.raises(transcribe.VoiceError, match="no se entiende"):
        transcribe.transcribe(connection, b"audio")
    _whisper(tmp_path / "whisper-cli", '{"transcription": [{"offsets": null, "text": " sin tiempos"}]}')
    assert transcribe.transcribe(connection, b"audio")["segments"] == [{"start": 0.0, "end": 0.0, "text": "sin tiempos"}]
    _whisper(tmp_path / "whisper-cli", '[1, 2]')
    with pytest.raises(transcribe.VoiceError, match="no se entiende"):
        transcribe.transcribe(connection, b"audio")
    connection.close()


def test_una_transcripcion_a_la_vez(tmp_path, tools):
    ffmpeg, whisper, model = tools
    connection = _connection(tmp_path)
    transcribe.save_settings(connection, {"binary": whisper, "ffmpeg": ffmpeg, "model": model})
    transcribe._busy.acquire()
    try:
        with pytest.raises(transcribe.VoiceBusy):
            transcribe.transcribe(connection, b"audio")
    finally:
        transcribe._busy.release()
    assert transcribe.transcribe(connection, b"audio")["text"] == "Hola, esto es una prueba."
    connection.close()


def test_solo_programas_con_su_nombre_y_que_responden(tmp_path, tools, monkeypatch):
    ffmpeg, whisper, model = tools
    connection = _connection(tmp_path)
    other = _program(tmp_path / "calc", "exit 0\n")
    with pytest.raises(transcribe.VoiceError, match="no es ffmpeg"):
        transcribe.save_settings(connection, {"ffmpeg": other})
    python_whisper = _program(tmp_path / "whisper", 'echo "usage: whisper [--output_format]"\n')
    with pytest.raises(transcribe.VoiceError, match="no responde como whisper.cpp"):
        transcribe.save_settings(connection, {"binary": python_whisper})
    monkeypatch.setattr(transcribe.sys, "platform", "win32")
    bat = tmp_path / "ffmpeg.bat"
    bat.write_text("@echo off")
    assert not transcribe._runnable(bat, transcribe.FFMPEG_NAMES), "en Windows un .bat pasaría por cmd.exe"
    exe = tmp_path / "FFmpeg.EXE"
    exe.write_bytes(b"MZ")
    assert transcribe._runnable(exe, transcribe.FFMPEG_NAMES)
    connection.close()


def test_prefiere_turbo_y_acepta_la_cache_de_hugging_face(tmp_path, monkeypatch):
    monkeypatch.setattr(transcribe.Path, "home", lambda: tmp_path)
    hub = tmp_path / ".cache/huggingface/hub/models--ggerganov--whisper.cpp"
    (hub / "blobs").mkdir(parents=True)
    (hub / "blobs/abc").write_bytes(b"x" * 5)
    (hub / "snapshots/123").mkdir(parents=True)
    (hub / "snapshots/123/ggml-large-v3-turbo.bin").symlink_to(hub / "blobs/abc")
    (tmp_path / ".cache/whisper").mkdir(parents=True)
    (tmp_path / ".cache/whisper/ggml-large-v3.bin").write_bytes(b"x" * 30)
    outside = tmp_path / "fuera.bin"
    outside.write_bytes(b"x" * 99)
    (tmp_path / ".cache/whisper/ggml-enlace.bin").symlink_to(outside)
    models = transcribe.find_models()
    assert [m["name"] for m in models] == ["large-v3", "large-v3-turbo"], "los enlaces fuera de su árbol no cuentan"
    assert transcribe.preferred_model(models).endswith("ggml-large-v3-turbo.bin")
