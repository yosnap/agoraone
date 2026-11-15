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
