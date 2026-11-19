"""Notes to act on in a project's repository: only new files inside the local copy Orca has, nothing overwritten,
no way out of the folder, and never the note of a private mail."""

import json
import os

import pytest
from fastapi.testclient import TestClient

from agora_core import github_issues, orca_launch, repo_notes
from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

from test_orca_launch import SNAPSHOT, add_mail

SECRET = "a" * 64


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "Web"
    (root / ".git").mkdir(parents=True)
    (root / "docs").mkdir()
    (root / "docs" / "leeme.md").write_text("original")
    (root / "node_modules" / "x").mkdir(parents=True)
    (root / "src" / "app").mkdir(parents=True)
    return root


def test_crea_la_nota_y_las_carpetas_que_faltan(repo):
    path = repo_notes.save(str(repo), "docs/notas", "Acme - Cambio: logo", "# Cambio")
    assert path == "docs/notas/Acme - Cambio  logo.md".replace("  ", " ")
    assert (repo / path).read_text() == "# Cambio\n"


def test_nunca_sobrescribe_un_archivo(repo):
    with pytest.raises(repo_notes.RepoNoteError, match="no se sobrescribe"):
        repo_notes.save(str(repo), "docs", "leeme", "otra cosa")
    assert (repo / "docs" / "leeme.md").read_text() == "original"


@pytest.mark.parametrize("folder", ["../fuera", "docs/../../fuera", ".git/hooks", "docs/.oculta"])
def test_no_sale_del_repositorio_ni_entra_en_carpetas_ocultas(repo, folder):
    with pytest.raises(repo_notes.RepoNoteError):
        repo_notes.save(str(repo), folder, "nota", "x")
    assert not (repo.parent / "fuera").exists() and not (repo / ".git" / "hooks").exists()


def test_no_sigue_enlaces(repo, tmp_path):
    outside = tmp_path / "fuera"
    outside.mkdir()
    os.symlink(outside, repo / "atajo")
    with pytest.raises(repo_notes.RepoNoteError, match="enlace"):
        repo_notes.save(str(repo), "atajo", "nota", "x")
    assert list(outside.iterdir()) == []


def test_las_carpetas_no_incluyen_ocultas_ni_dependencias(repo):
    assert repo_notes.folders(str(repo)) == ["docs", "src", "src/app"]


def test_la_copia_local_es_la_que_tiene_orca(repo, monkeypatch, tmp_path):
    from agora_core.db import migrate
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    connection.execute("INSERT INTO setting (key, value) VALUES ('central.snapshot', ?)", (json.dumps(SNAPSHOT),))
    monkeypatch.setattr(orca_launch, "projects", lambda runner=None, fresh=False: {"acme/web": {"id": "github:acme/web", "name": "Web", "repoIds": ["r1"]}})
    monkeypatch.setattr(orca_launch, "repo_paths", lambda runner=None: {"r1": str(repo)})
    assert repo_notes.local_root(connection, "Acme", "Web") == ("Acme/Web", os.path.realpath(repo))
    with pytest.raises(repo_notes.RepoNoteError, match="aún no está en Orca"):
        repo_notes.local_root(connection, "Acme", "Tienda")
    with pytest.raises(repo_notes.RepoNoteError, match="no tiene repositorio"):
        repo_notes.local_root(connection, "Acme", "Sin repo")
    connection.close()


@pytest.fixture
def client(tmp_path, monkeypatch, repo):
    monkeypatch.setattr(orca_launch, "projects", lambda runner=None, fresh=False: {"acme/web": {"id": "github:acme/web", "name": "Web", "repoIds": ["r1"]}})
    monkeypatch.setattr(orca_launch, "repo_paths", lambda runner=None: {"r1": str(repo)})
    monkeypatch.setattr(github_issues, "visibility", lambda repo, runner=None: "public")
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None)
    with TestClient(app, base_url=f"http://{settings.authority}") as test_client:
        connection = connect(settings.data_dir / DB_NAME)
        connection.execute("INSERT INTO setting (key, value) VALUES ('central.snapshot', ?)", (json.dumps(SNAPSHOT),))
        connection.commit()
        yield test_client, connection
        connection.close()


def test_rutas_carpetas_y_nota(client, repo):
    test_client, connection = client
    headers = {SECRET_HEADER: SECRET}
    listed = test_client.get("/orca/repo-folders", params={"client": "Acme", "project": "Web"}, headers=headers).json()
    assert listed["folders"] == ["docs", "src", "src/app"] and listed["suggested"] == "docs/notas" and listed["visibility"] == "public"
    normal = add_mail(connection)
    body = {"client": "Acme", "project": "Web", "folder": "docs/notas", "title": "Menú", "content": "Arreglar el menú"}
    made = test_client.post("/orca/repo-note", json={**body, "inboxId": normal}, headers=headers)
    assert made.status_code == 201 and made.json()["path"] == "docs/notas/Menú.md"
    connection.execute("UPDATE mail_summary SET confidentiality = 'private' WHERE message_id = ?", (normal,))
    connection.commit()
    refused = test_client.post("/orca/repo-note", json={**body, "title": "Otro", "inboxId": normal}, headers=headers)
    assert refused.status_code == 422 and "privado" in refused.json()["error"]
    assert not (repo / "docs" / "notas" / "Otro.md").exists()
    connection.execute("UPDATE mail_summary SET confidentiality = 'normal' WHERE message_id = ?", (normal,))
    connection.commit()
    again = test_client.post("/orca/repo-note", json={**body, "inboxId": normal}, headers=headers)
    assert again.status_code == 422 and (repo / "docs" / "notas" / "Menú.md").read_text() == "Arreglar el menú\n"


def test_caracteres_invisibles_no_abren_carpetas_ocultas(repo):
    with pytest.raises(repo_notes.RepoNoteError):
        repo_notes.save(str(repo), "‌.git", "nota", "x")
    assert repo_notes.file_name("a‮b") == "ab.md"


def test_si_falla_la_escritura_no_deja_nada(repo, monkeypatch):
    def broken(*args):
        raise OSError("disco lleno")
    monkeypatch.setattr(repo_notes.os, "write", broken)
    with pytest.raises(OSError):
        repo_notes.save(str(repo), "docs/otra/mas", "nota", "x")
    assert not (repo / "docs" / "otra").exists()
    with pytest.raises(repo_notes.RepoNoteError):
        repo_notes.save(str(repo), "docs", "nota", "\ud800")
