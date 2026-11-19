"""Covers of the user's own music: the picture inside the file or the album's image next to it; nothing else."""

import struct

from agora_core import music, music_cover

JPEG = b"\xff\xd8\xff\xe0" + b"imagen" * 10
PNG = b"\x89PNG\r\n\x1a\n" + b"png" * 10


def id3(picture: bytes, version: int = 3) -> bytes:
    body = b"\x00image/jpeg\x00\x03portada\x00" + picture
    size = struct.pack(">I", len(body)) if version == 3 else bytes([(len(body) >> 21) & 127, (len(body) >> 14) & 127, (len(body) >> 7) & 127, len(body) & 127])
    frame = b"APIC" + size + b"\x00\x00" + body
    total = len(frame)
    return b"ID3" + bytes([version, 0, 0]) + bytes([(total >> 21) & 127, (total >> 14) & 127, (total >> 7) & 127, total & 127]) + frame + b"\xff\xfbaudio"


def flac(picture: bytes) -> bytes:
    mime, text = b"image/png", b""
    body = struct.pack(">II", 3, len(mime)) + mime + struct.pack(">I", len(text)) + text + b"\x00" * 16 + struct.pack(">I", len(picture)) + picture
    return b"fLaC" + bytes([0x80 | 6]) + len(body).to_bytes(3, "big") + body


def test_la_portada_sale_del_propio_archivo(tmp_path):
    (tmp_path / "a.mp3").write_bytes(id3(JPEG))
    (tmp_path / "b.mp3").write_bytes(id3(JPEG, version=4))
    (tmp_path / "c.flac").write_bytes(flac(PNG))
    assert music_cover.of_track(tmp_path / "a.mp3") == (JPEG, "image/jpeg")
    assert music_cover.of_track(tmp_path / "b.mp3") == (JPEG, "image/jpeg")
    assert music_cover.of_track(tmp_path / "c.flac") == (PNG, "image/png")


def test_si_no_la_lleva_vale_la_imagen_del_album(tmp_path):
    (tmp_path / "01 Canción.mp3").write_bytes(b"\xff\xfbaudio")
    assert music_cover.of_track(tmp_path / "01 Canción.mp3") is None
    (tmp_path / "notas.jpg").write_bytes(JPEG)
    assert music_cover.of_track(tmp_path / "01 Canción.mp3") is None
    (tmp_path / "Cover.png").write_bytes(PNG)
    assert music_cover.of_track(tmp_path / "01 Canción.mp3") == (PNG, "image/png")


def test_lo_que_no_es_una_imagen_no_vale(tmp_path):
    (tmp_path / "a.mp3").write_bytes(id3(b"<script>no</script>"))
    assert music_cover.of_track(tmp_path / "a.mp3") is None


def test_el_volumen_y_el_punto_de_la_cancion_se_validan(monkeypatch):
    monkeypatch.setattr(music, "available", lambda: {"adapter": "macos", "note": None})
    monkeypatch.setattr(music, "_running", lambda process: True)
    sent = []
    monkeypatch.setattr(music, "_osascript", lambda script, *args: sent.append(script) or "")
    music.set_level("music", "volume", 140)
    music.set_level("spotify", "seek", 61.25)
    assert sent == ['tell application "Music" to set sound volume to 100', 'tell application "Spotify" to set player position to 61.2']
    for what, value in (("volume", -1), ("seek", float("nan")), ("otra", 3)):
        try:
            music.set_level("music", what, value)
        except music.MusicError:
            continue
        raise AssertionError(what)


def test_un_archivo_danado_no_cuelga_ni_falla(tmp_path):
    import signal

    def utf16_apic(description: bytes) -> bytes:
        body = b"\x01image/jpeg\x00\x03" + description + JPEG
        frame = b"APIC" + struct.pack(">I", len(body)) + b"\x00\x00" + body
        total = len(frame)
        return b"ID3\x03\x00\x00" + bytes([(total >> 21) & 127, (total >> 14) & 127, (total >> 7) & 127, total & 127]) + frame
    signal.alarm(3)  # a loop would fail the test instead of hanging it
    try:
        (tmp_path / "sin-fin.mp3").write_bytes(utf16_apic(b"\xff\xfeA"))
        (tmp_path / "impar.mp3").write_bytes(utf16_apic(b"\xff\xfeA\x00\x00"))
        assert music_cover.of_track(tmp_path / "sin-fin.mp3") is None
        music_cover.of_track(tmp_path / "impar.mp3")
        broken = b"fLaC" + bytes([0x80 | 6]) + (40).to_bytes(3, "big") + struct.pack(">II", 3, 9999) + b"\x00" * 32
        (tmp_path / "rota.flac").write_bytes(broken)
        assert music_cover.of_track(tmp_path / "rota.flac") is None
    finally:
        signal.alarm(0)
    (tmp_path / "cover.jpg").write_bytes(b"<svg>no</svg>")
    assert music_cover.of_track(tmp_path / "rota.flac") is None
