"""The cover of a song of the user's own library, for the music card: the picture inside the file (ID3 in MP3, the
PICTURE block in FLAC, `covr` in M4A) or, failing that, the album's image next to it (cover.jpg, folder.jpg…).
Only read, never written; a file that cannot be read just has no cover."""

import struct
from pathlib import Path

READ = 16 * 1024 * 1024
MAX_IMAGE = 8 * 1024 * 1024
NAMES = ("cover", "folder", "front", "album", "albumart", "artwork")
IMAGES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}


def _mime(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return None


def _image(data: bytes) -> tuple[bytes, str] | None:
    kind = _mime(data)
    return (data, kind) if kind and len(data) <= MAX_IMAGE else None


def _id3(head: bytes) -> tuple[bytes, str] | None:
    if head[:3] != b"ID3" or len(head) < 10:
        return None
    version = head[3]
    size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
    at, end = 10, min(10 + size, len(head))
    while at + 10 <= end:
        frame, length = head[at:at + 4], head[at + 4:at + 8]
        size = (length[0] << 21) | (length[1] << 14) | (length[2] << 7) | length[3] if version >= 4 else struct.unpack(">I", length)[0]
        if not frame.strip(b"\x00") or size <= 0:
            break
        body = head[at + 10:at + 10 + size]
        if frame == b"APIC" and body:
            encoding, rest = body[0], body[1:]
            rest = rest[rest.index(b"\x00") + 1:] if b"\x00" in rest else rest  # MIME type
            rest = rest[1:]  # picture type
            ending = b"\x00\x00" if encoding in (1, 2) else b"\x00"
            cut = rest.find(ending)
            while encoding in (1, 2) and cut >= 0 and cut % 2:  # UTF-16 descriptions end on an even byte
                cut = rest.find(ending, cut + 1)
            return _image(rest[cut + len(ending):]) if cut >= 0 else None
        at += 10 + size
    return None


def _flac(head: bytes) -> tuple[bytes, str] | None:
    if head[:4] != b"fLaC":
        return None
    at = 4
    while at + 4 <= len(head):
        last, kind, size = head[at] & 0x80, head[at] & 0x7F, int.from_bytes(head[at + 1:at + 4], "big")
        body = head[at + 4:at + 4 + size]
        if kind == 6 and len(body) > 32:
            mime = struct.unpack(">I", body[4:8])[0]
            text = struct.unpack(">I", body[8 + mime:12 + mime])[0]
            start = 12 + mime + text + 16
            length = struct.unpack(">I", body[start:start + 4])[0]
            return _image(body[start + 4:start + 4 + length])
        if last:
            break
        at += 4 + size
    return None


def _mp4(head: bytes) -> tuple[bytes, str] | None:
    at = head.find(b"covr")
    if at < 0 or head[at + 8:at + 12] != b"data":
        return None
    size = struct.unpack(">I", head[at + 4:at + 8])[0]
    return _image(head[at + 20:at + 4 + size])


def of_track(path: Path) -> tuple[bytes, str] | None:
    with open(path, "rb") as file:
        head = file.read(READ)
    try:
        found = _id3(head) or _flac(head) or (_mp4(head) if path.suffix.lower() in (".m4a", ".aac", ".mp4") else None)
    except (struct.error, IndexError, ValueError):  # a damaged or odd file: no cover, never an error
        found = None
    if found:
        return found
    for picture in sorted(path.parent.iterdir()):
        # Only a real image file in the album's own folder (not a link to somewhere else).
        if (picture.is_file() and not picture.is_symlink() and picture.stem.lower() in NAMES and picture.suffix.lower() in IMAGES
                and picture.stat().st_size <= MAX_IMAGE):
            found = _image(picture.read_bytes())
            if found:
                return found
    return None
