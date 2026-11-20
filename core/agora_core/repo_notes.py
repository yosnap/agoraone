"""Notes to act on, saved in the local copy of a Central project's repository that Orca already has (user's
decision, 17/11/2026). Only new files: nothing that exists is overwritten, changed or deleted, nothing is committed
or pushed, and nothing is written outside the repository's folder (no «..», no links, no hidden folders such as
.git). A mail that is private or «solo en este Mac» is refused here, whatever the screen sent."""

import os
import re
import sqlite3
import stat
import subprocess
import unicodedata

from . import orca_launch
from .github_issues import project_repo
from . import system_words

SUGGESTED = "docs/notas"
SKIP = {"node_modules", "venv", "dist", "build", "target", "__pycache__", "vendor", "coverage", "out"}
MAX_FOLDERS = 3000
MAX_DEPTH = 8
MAX_CONTENT = 200_000
FORBIDDEN = re.compile(r"[\\/:*?\"<>|\x00-\x1f  ]")


class RepoNoteError(ValueError):
    pass


def local_root(connection: sqlite3.Connection, client: str, project: str, runner=subprocess.run) -> tuple[str, str]:
    """(«owner/name», the real folder of its local copy) of a Central project whose repository is in Orca."""
    repo = project_repo(connection, client, project)
    if not repo:
        raise RepoNoteError("Ese proyecto no tiene repositorio de GitHub en Central.")
    try:
        found = orca_launch.projects(runner).get(repo.casefold())
        paths = orca_launch.repo_paths(runner) if found else {}
    except orca_launch.OrcaError as error:
        raise RepoNoteError(str(error)) from error
    if not found:
        raise RepoNoteError(f"El repositorio {repo} aún no está en Orca.")
    for ident in found.get("repoIds") or []:
        path = paths.get(ident)
        if path and os.path.isdir(path) and os.path.exists(os.path.join(path, ".git")):
            return repo, os.path.realpath(path)
    raise RepoNoteError(f"No encuentro en {system_words.HERE} la copia local de {repo} que usa Orca.")


def folders(root: str) -> list[str]:
    """The repository's folders (relative, with «/»), without hidden ones, links or build and dependency folders."""
    found: list[str] = []
    for current, dirs, _files in os.walk(root, followlinks=False):
        relative = os.path.relpath(current, root)
        depth = 0 if relative == "." else relative.count(os.sep) + 1
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP and not os.path.islink(os.path.join(current, d)))
        if depth >= MAX_DEPTH:
            dirs[:] = []
        for name in dirs:
            found.append(os.path.join(relative, name).replace(os.sep, "/") if relative != "." else name)
            if len(found) >= MAX_FOLDERS:
                return found
    return found


def _visible(text: str) -> str:
    """Without invisible format characters (zero-width, bidi marks…): «\u200c.git» is not a way into .git."""
    return "".join(c for c in unicodedata.normalize("NFC", text) if unicodedata.category(c) != "Cf")


def _part(name: str) -> str:
    clean = " ".join(FORBIDDEN.sub(" ", _visible(name)).split())
    if not clean or clean.startswith(".") or len(clean.encode()) > 120:
        raise RepoNoteError(f"«{name[:60]}» no vale como nombre de carpeta en el repositorio.")
    return clean


def file_name(title: str) -> str:
    clean = " ".join(FORBIDDEN.sub(" ", _visible(title)).split()).lstrip(". ")
    while len(clean.encode()) > 200:
        clean = clean[:-1]
    if not clean.strip():
        raise RepoNoteError("La nota necesita un título.")
    return f"{clean.strip()}.md"


def mail_level(connection: sqlite3.Connection, message_id: int) -> str:
    from .mail_inbox import _LEVEL

    row = connection.execute(
        f"""SELECT {_LEVEL} AS level FROM mail_summary s JOIN mail_message m ON m.id = s.message_id JOIN mail_account a ON a.id = m.account_id
            LEFT JOIN mail_rule r ON r.id = s.rule_id WHERE s.message_id = ?""", (message_id,)).fetchone()
    if row is None:
        raise RepoNoteError("Ese correo ya no está en la Bandeja.")
    return row["level"]


def save(root: str, folder: str, title: str, content: str) -> str:
    """Creates «<folder>/<title>.md» inside `root` (the folders that are missing too) and returns its relative path."""
    if len(content) > MAX_CONTENT:
        raise RepoNoteError("La nota es demasiado larga.")
    try:
        data = (content if content.endswith("\n") else content + "\n").encode("utf-8")
    except UnicodeError as error:
        raise RepoNoteError("El texto de la nota tiene caracteres que no se pueden guardar.") from error
    return _write(root, folder, file_name(title), data)


def save_file(root: str, folder: str, name: str, data: bytes) -> str:
    """A mail's attachment or shared document next to its note, under the name the screen showed."""
    from .note_sources import safe_name, savable

    if safe_name(name) != name or not savable(name):
        raise RepoNoteError(f"«{name[:80]}» no vale como nombre de archivo, o es de un tipo que no se guarda junto a la nota.")
    return _write(root, folder, name, data)


def _write(root: str, folder: str, name: str, data: bytes) -> str:
    """Creates `name` in `folder` inside `root` (the folders that are missing too) and returns its relative path.
    Walks with directory descriptors that never follow a link, so nothing swapped in meanwhile leads outside; refuses a
    name that already exists, and leaves nothing behind (no empty file, no new empty folder) when it fails."""
    parts = [_part(p) for p in folder.replace("\\", "/").split("/") if p.strip()]
    if os.name == "nt":
        return _write_windows(root, parts, name, data)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    opened = [os.open(os.path.realpath(root), os.O_RDONLY | os.O_DIRECTORY)]
    made: list[tuple[int, str]] = []  # (descriptor of the parent, name) of each folder created here

    def undo():
        for parent, part in reversed(made):
            try:
                os.rmdir(part, dir_fd=parent)
            except OSError:
                pass
    try:
        for part in parts:
            try:
                if not _exists(part, opened[-1]):
                    os.mkdir(part, dir_fd=opened[-1])
                    made.append((opened[-1], part))
                opened.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | nofollow, dir_fd=opened[-1]))
            except NotADirectoryError as error:
                if stat.S_ISLNK(os.stat(part, dir_fd=opened[-1], follow_symlinks=False).st_mode):
                    raise RepoNoteError(f"«{part}» es un enlace: la nota no sale de la carpeta del repositorio.") from error
                raise RepoNoteError(f"«{part}» es un archivo, no una carpeta.") from error
            except OSError as error:
                if isinstance(error, RepoNoteError):
                    raise
                raise RepoNoteError(f"«{part}» es un enlace o no se puede abrir: la nota no sale de la carpeta del repositorio.") from error
        try:
            handle = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, 0o644, dir_fd=opened[-1])
        except FileExistsError as error:
            raise RepoNoteError(f"Ya hay un archivo «{name}» en esa carpeta: cambia el título (no se sobrescribe nada).") from error
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(handle, view):]
        except OSError:
            os.close(handle)
            os.unlink(name, dir_fd=opened[-1])
            raise
        os.close(handle)
        made.clear()
        return "/".join([*parts, name])
    except BaseException:
        undo()
        raise
    finally:
        for descriptor in opened:
            os.close(descriptor)


def _write_windows(root: str, parts: list[str], name: str, data: bytes) -> str:
    """`_write` on Windows, which has no directory descriptors: each folder is checked by path right after it is
    reached (no symbolic link, no junction, and its real path is the expected one inside the real root), and the
    folder is checked once more after the file is written, undoing everything if it was swapped for a link."""
    from pathlib import Path

    def leads_out(path: str) -> bool:
        return Path(path).is_symlink() or Path(path).is_junction() or os.path.normcase(os.path.realpath(path)) != os.path.normcase(path)

    current = os.path.realpath(root)
    made: list[str] = []  # each folder created here, to take back on failure
    try:
        for part in parts:
            current = os.path.join(current, part)
            try:
                os.mkdir(current)
                made.append(current)
            except FileExistsError:
                pass
            except OSError as error:
                raise RepoNoteError(f"«{part}» es un enlace o no se puede abrir: la nota no sale de la carpeta del repositorio.") from error
            if leads_out(current):
                raise RepoNoteError(f"«{part}» es un enlace: la nota no sale de la carpeta del repositorio.")
            if not os.path.isdir(current):
                raise RepoNoteError(f"«{part}» es un archivo, no una carpeta.")
        target = os.path.join(current, name)
        try:
            handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o644)
        except FileExistsError as error:
            raise RepoNoteError(f"Ya hay un archivo «{name}» en esa carpeta: cambia el título (no se sobrescribe nada).") from error
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(handle, view):]
            if parts and leads_out(current):
                raise RepoNoteError("La carpeta se cambió por un enlace mientras se guardaba: no se guarda nada.")
        except BaseException:
            os.close(handle)
            os.unlink(target)
            raise
        os.close(handle)
        made.clear()
        return "/".join([*parts, name])
    except BaseException:
        for path in reversed(made):
            try:
                os.rmdir(path)
            except OSError:
                pass
        raise


def _exists(part: str, parent: int) -> bool:
    try:
        os.stat(part, dir_fd=parent, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False
