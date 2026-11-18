"""Write one identity file of a Hermes profile (SOUL.md, MEMORY.md or USER.md) safely.

Input (stdin, JSON): root (the Hermes home), path, content, expected (revision the user edited, null
for a new file), backupDir, lock (take Hermes' own memory lock), createParent.
The memory files are written under the same exclusive ``<file>.lock`` that Hermes' memory tool
uses, so neither side can interleave a write. The previous version is copied to backupDir first,
and the new content replaces the file atomically (temp file, fsync, rename), keeping its mode.
"""
import hashlib
import json
import os
import stat
import sys
import tempfile
import time

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl


KEEP_BACKUPS = 20  # per file; older copies are removed


def revision(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def is_link(path):
    return os.path.islink(path) or (hasattr(os.path, "isjunction") and os.path.isjunction(path))


def main(request):
    root, path, content = os.path.realpath(request["root"]), request["path"], request["content"]
    norm_root = os.path.normcase(root)
    parent = os.path.dirname(path)
    # The whole directory chain must be real (no symlinks anywhere) and inside the Hermes home.
    def inside(directory):
        if is_link(directory):
            return False
        real = os.path.normcase(os.path.realpath(directory))
        given = os.path.normcase(os.path.abspath(directory))
        return real == given and (real == norm_root or real.startswith(norm_root + os.sep))
    if request.get("createParent") and not os.path.lexists(parent):
        if not inside(os.path.dirname(parent)):
            return {"ok": False, "error": "unsafe"}
        os.mkdir(parent, 0o700)
    if not inside(parent):
        return {"ok": False, "error": "unsafe"}
    lock = None
    if request.get("lock"):
        lock_path = path + ".lock"
        if is_link(lock_path):
            return {"ok": False, "error": "unsafe"}
        try:
            lock = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        except OSError:
            return {"ok": False, "error": "unsafe"}
        if is_link(lock_path):
            os.close(lock)
            return {"ok": False, "error": "unsafe"}
        if hasattr(os, "fchmod"):
            os.fchmod(lock, 0o600)
        if sys.platform == "win32":
            os.lseek(lock, 0, os.SEEK_SET)
            for attempt in range(6):
                try:
                    msvcrt.locking(lock, msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    if attempt == 5:
                        os.close(lock)
                        raise
        else:
            fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        current, mode = None, 0o600
        if os.path.lexists(path) or is_link(path):
            if is_link(path):
                return {"ok": False, "error": "unsafe"}
            try:
                handle = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            except OSError:
                return {"ok": False, "error": "unsafe"}
            with os.fdopen(handle, "rb") as reader:
                info = os.fstat(reader.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1 or is_link(path):
                    return {"ok": False, "error": "unsafe"}
                # utf-8-sig like Hermes (and Node's TextDecoder): a BOM never changes the revision.
                current = reader.read().decode("utf-8-sig")
            mode = stat.S_IMODE(info.st_mode)
        if (revision(current) if current is not None else None) != request.get("expected"):
            return {"ok": False, "error": "conflict"}
        backup = None
        if current is not None:
            os.makedirs(request["backupDir"], 0o700, exist_ok=True)
            stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + f"-{time.time_ns() % 1_000_000:06d}"
            backup = os.path.join(request["backupDir"], f"{os.path.basename(path)}.{stamp}.bak")
            descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
                handle.write(current)
                handle.flush()
                os.fsync(handle.fileno())
            prefix = os.path.basename(path) + "."
            copies = sorted(name for name in os.listdir(request["backupDir"]) if name.startswith(prefix) and name.endswith(".bak"))
            for old in copies[:-KEEP_BACKUPS]:
                os.unlink(os.path.join(request["backupDir"], old))
        descriptor, temporary = tempfile.mkstemp(prefix=".agora_", dir=parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, mode)
            os.replace(temporary, path)
        except BaseException:
            if os.path.exists(temporary):
                os.unlink(temporary)
            raise
        try:  # the file is already replaced; a failed directory sync must not report a failed save
            directory = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError:
            pass
        return {"ok": True, "revision": revision(content), "backup": os.path.basename(backup) if backup else None}
    finally:
        if lock is not None:
            if sys.platform == "win32":
                os.lseek(lock, 0, os.SEEK_SET)
                msvcrt.locking(lock, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)
            os.close(lock)


if __name__ == "__main__":
    try:
        print(json.dumps(main(json.loads(sys.stdin.read()))))
    except Exception:
        # No paths or contents in errors.
        print(json.dumps({"ok": False, "error": "write_failed"}))
