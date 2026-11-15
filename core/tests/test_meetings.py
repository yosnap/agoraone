"""Recorded meetings: two tracks, one at a time, the microphone in pieces, a recording that stops by itself
when the interface stops sending, meetings left recording by a dead core, and each access sees only its own.
The system's audio is recorded by a stand-in of the macOS helper (a shell script that answers like it)."""

import stat
import sys
import time

import pytest
from fastapi.testclient import TestClient

from agora_core import meetings, system_audio
from agora_core.app import SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings
from tests.test_fiscal_excel import MemorySecrets

SECRET, OWNER, OTHER = "a" * 64, "b" * 64, "c" * 64
pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="el auxiliar de prueba es un guion de shell")
HELPER = """#!/bin/sh
out="$1"
trap 'printf "audio del sistema" > "$out"; exit 0' TERM
echo ready
while :; do sleep 0.1; done
"""


@pytest.fixture
def client(tmp_path, monkeypatch):
    helper = tmp_path / "agora-system-audio"
    helper.write_text(HELPER)
    helper.chmod(helper.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(system_audio, "HELPER", helper)
    monkeypatch.setattr(system_audio.sys, "platform", "darwin")
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as test:
        test.data = tmp_path / "data"
        yield test


def h(owner=OWNER):
    return {SECRET_HEADER: SECRET, "x-agora-owner": owner}


def test_graba_dos_pistas_y_las_borra(client):
    started = client.post("/meetings", json={"title": "  Equipo   semanal ", "mic_type": "audio/webm;codecs=opus"}, headers=h()).json()
    assert started["status"] == "recording" and started["title"] == "Equipo semanal" and started["system_source"] == "macos"
    assert client.post("/meetings", json={"mic_type": "audio/webm"}, headers=h()).status_code == 409, "una a la vez"
    for piece in (b"uno-", b"dos"):
        assert client.post(f"/meetings/{started['id']}/mic", content=piece, headers=h()).status_code == 200
    assert client.post(f"/meetings/{started['id']}/mic", content=b"x", headers=h(OTHER)).status_code == 404, "solo el que graba"
    assert client.get("/meetings", headers=h()).json()["recording"] == started["id"]
    done = client.post(f"/meetings/{started['id']}/stop", headers=h()).json()
    assert done["status"] == "recorded" and done["mic_bytes"] == 7 and done["system_bytes"] == len("audio del sistema")
    folder = client.data / "meetings" / str(started["id"])
    assert (folder / "microfono.webm").read_bytes() == b"uno-dos" and (folder / "sistema.m4a").is_file()
    assert client.post(f"/meetings/{started['id']}/mic", content=b"tarde", headers=h()).status_code == 409
    assert client.get("/meetings", headers=h(OTHER)).json()["meetings"] == []
    assert client.delete(f"/meetings/{started['id']}", headers=h(OTHER)).status_code == 404
    assert client.delete(f"/meetings/{started['id']}", headers=h()).json() == {"deleted": True}
    assert not folder.exists() and client.get("/meetings", headers=h()).json()["meetings"] == []


def test_sin_audio_del_sistema_sigue_con_el_microfono(client, monkeypatch):
    monkeypatch.setattr(system_audio, "HELPER", client.data / "no-existe")
    started = client.post("/meetings", json={"mic_type": "audio/mp4", "confidentiality": "local_only"}, headers=h()).json()
    assert started["system_source"] is None and "micrófono" in started["note"] and started["confidentiality"] == "local_only"
    assert client.delete(f"/meetings/{started['id']}", headers=h()).status_code == 409, "no se borra mientras graba"
    assert client.post(f"/meetings/{started['id']}/stop", headers=h()).json()["status"] == "recorded"
    assert client.post("/meetings", json={"mic_type": "audio/x-raro"}, headers=h()).status_code == 422
    assert client.post("/meetings", json={"mic_type": "audio/webm", "confidentiality": "secreto"}, headers=h()).status_code == 422


def test_se_detiene_sola_si_la_interfaz_deja_de_enviar(client, monkeypatch):
    monkeypatch.setattr(meetings, "SILENT_AFTER", 0.3)
    monkeypatch.setattr(meetings, "WATCH_EVERY", 0.1)
    started = client.post("/meetings", json={"mic_type": "audio/webm"}, headers=h()).json()
    for _ in range(50):
        state = client.get("/meetings", headers=h()).json()
        if state["recording"] is None:
            break
        time.sleep(0.1)
    meeting = state["meetings"][0]
    assert meeting["id"] == started["id"] and meeting["status"] == "recorded" and "dejó de enviar" in meeting["note"]
    assert meeting["system_bytes"] > 0, "el audio del sistema se cerró bien"


def test_lo_que_dejo_grabando_un_nucleo_muerto_queda_interrumpido(tmp_path):
    from agora_core.db import DB_NAME, connect, migrate

    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    connection.execute("INSERT INTO meeting (owner, title, status, started_at, mic_type) VALUES (?, 'x', 'recording', '2026-11-15T10:00:00Z', 'webm')", (OWNER,))
    recorder = meetings.Recorder(tmp_path, lambda: connect(tmp_path / DB_NAME))
    recorder.recover(connection)
    assert recorder.list(connection, OWNER)[0]["status"] == "interrupted"
    connection.close()
