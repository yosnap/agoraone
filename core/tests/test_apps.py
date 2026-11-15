"""Opening apps: only installed ones, by their identifier; the allowed ones without asking, the rest only
once confirmed; nothing typed ever becomes a command."""

import pytest

from agora_core import apps
from agora_core.db import DB_NAME, connect, migrate


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(apps, "installed", lambda: [{"id": "com.apple.Notes", "name": "Notas"}, {"id": "com.spotify.client", "name": "Spotify"}])
    opened = []
    monkeypatch.setattr(apps.subprocess, "run", lambda command, **kw: opened.append(command) or type("Done", (), {"returncode": 0})())
    monkeypatch.setattr(apps.sys, "platform", "darwin")
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    yield c, opened
    c.close()


def test_abrir_solo_lo_instalado_y_lo_permitido(setup):
    c, opened = setup
    assert apps.save_allowed(c, ["com.apple.Notes", "rm -rf /", "com.desconocida"]) == ["com.apple.Notes"]
    assert apps.open_app(c, "com.apple.Notes", confirmed=False) == "Abierta Notas."
    assert opened[-1] == ["/usr/bin/open", "-b", "com.apple.Notes"]
    with pytest.raises(apps.AppsError) as refused:
        apps.open_app(c, "com.spotify.client", confirmed=False)
    assert refused.value.status == 409 and len(opened) == 1, "sin permitir, pide confirmación"
    assert apps.open_app(c, "com.spotify.client", confirmed=True) == "Abierta Spotify."
    with pytest.raises(apps.AppsError) as missing:
        apps.open_app(c, "; rm -rf ~", confirmed=True)
    assert missing.value.status == 404 and len(opened) == 2
