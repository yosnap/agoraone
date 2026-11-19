"""The diagnosis only reads: every piece says whether it is here, which modules use it and how to get it."""

from agora_core import doctor
from agora_core.db import DB_NAME, connect, migrate


def test_diagnostico(tmp_path, monkeypatch):
    monkeypatch.setattr(doctor.local_model, "detect", lambda: None)
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    found = doctor.check(c, has_anthropic_key=False)
    ids = {p["id"]: p for p in found["pieces"]}
    assert {"hermes", "obsidian", "claude-code", "whisper", "whisper-model", "ffmpeg", "ollama", "music-folder"} <= set(ids)
    assert all(p["state"] in ("ok", "missing", "optional") and p["modules"] for p in found["pieces"])
    assert ids["music-folder"]["state"] == "optional" and found["missing"] == sum(p["state"] == "missing" for p in found["pieces"])
    c.close()


def test_central_no_necesita_ninguna_pieza(tmp_path, monkeypatch):
    """Central is reached through its web API only: the diagnosis never asks for bun nor anything of Central's."""
    import json

    monkeypatch.setattr(doctor.local_model, "detect", lambda: None)
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    c.execute("INSERT INTO setting (key, value) VALUES ('addons.central', ?)", (json.dumps({"path": "/ruta/de/central"}),))
    for piece in doctor.check(c, has_anthropic_key=False)["pieces"]:
        assert "bun" not in (piece["id"].lower(), piece["name"].lower())
        assert "central" not in json.dumps(piece, ensure_ascii=False).lower(), piece["id"]
    c.close()


def test_instalar_solo_lo_de_la_lista(monkeypatch):
    from agora_core import installer
    import pytest
    jobs = installer.Installer()
    with pytest.raises(installer.InstallError):
        jobs.start({"id": "x", "name": "X", "how": {"kind": "command", "command": "rm -rf ~"}})
    ran = []
    monkeypatch.setattr(installer.shutil, "which", lambda name: "/opt/homebrew/bin/brew")
    class Process:
        stdout = iter(["==> Instalando\n"])
        def wait(self):
            return 0
    monkeypatch.setattr(installer.subprocess, "Popen", lambda args, **kw: ran.append(args) or Process())
    jobs.start({"id": "ffmpeg", "name": "ffmpeg", "how": {"kind": "brew", "package": "ffmpeg"}})
    for _ in range(50):
        if jobs.state()["state"] != "running":
            break
        import time; time.sleep(0.02)
    assert ran == [["/opt/homebrew/bin/brew", "install", "ffmpeg"]] and jobs.state()["state"] == "done"
