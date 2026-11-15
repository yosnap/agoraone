"""The user's music: folders they pick, tracks named from the folders and file names, searched without accents,
and a file served only from inside those folders."""

import pytest

from agora_core import music_library
from agora_core.db import DB_NAME, connect, migrate


def test_biblioteca_local(tmp_path):
    music_library._cache.clear()
    music = tmp_path / "Música"
    (music / "Rosalía/Motomami").mkdir(parents=True)
    (music / "Rosalía/Motomami/01 - Saoko.mp3").write_bytes(b"ID3")
    (music / "Sueltas").mkdir()
    (music / "Sueltas/Miles Davis - So What.m4a").write_bytes(b"x")
    (music / "Sueltas/notas.txt").write_text("no")
    outside = tmp_path / "fuera.mp3"
    outside.write_bytes(b"x")
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    with pytest.raises(music_library.LibraryError):
        music_library.save_folders(c, [str(tmp_path / "no-existe")])
    music_library.save_folders(c, [str(music)])
    found = music_library.search(c, "rosalia saoko")
    assert [(t["title"], t["artist"], t["album"]) for t in found] == [("Saoko", "Rosalía", "Motomami")] and "path" not in found[0]
    assert [t["title"] for t in music_library.search(c, "miles")] == ["So What"]
    path, kind = music_library.file_of(c, found[0]["id"])
    assert path.name == "01 - Saoko.mp3" and kind == "audio/mpeg"
    with pytest.raises(music_library.LibraryError):
        music_library.file_of(c, "no-existe")
    c.close()
