"""Opening applications when the user asks (1.5): the apps installed on this computer, read from where each
system keeps them (macOS bundles in the Applications folders, Linux `.desktop` entries; Windows not yet), and
the user's list of the ones Watson may open without asking. An app is always opened by its identifier from
that list (a bundle id, a desktop id), never by a name or command typed by anyone; apps are only ever
opened, never closed or changed."""

import configparser
import hashlib
import json
import os
import plistlib
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from .db import transaction

SETTING = "apps"
CACHE_SECONDS = 300
_cache: dict = {}
_win_paths: dict[str, Path] = {}


class AppsError(RuntimeError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def _mac_apps() -> list[dict]:
    found: dict[str, dict] = {}
    for root in (Path("/Applications"), Path("/System/Applications"), Path.home() / "Applications", Path("/Applications/Utilities")):
        try:
            bundles = list(root.glob("*.app")) + list(root.glob("*/*.app"))
        except OSError:
            continue
        for bundle in bundles[:600]:
            try:
                with open(bundle / "Contents/Info.plist", "rb") as file:
                    info = plistlib.load(file)
            except (OSError, plistlib.InvalidFileException, ValueError):
                continue
            ident = info.get("CFBundleIdentifier")
            if not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9.\-_]{3,200}", ident) or ident in found:
                continue
            name = info.get("CFBundleDisplayName") or info.get("CFBundleName") or bundle.stem
            spanish = None
            try:  # the Spanish name the system shows («Notas», «Calendario»), when the app brings one
                with open(bundle / "Contents/Resources/es.lproj/InfoPlist.strings", "rb") as file:
                    local = plistlib.load(file)
                spanish = local.get("CFBundleDisplayName") or local.get("CFBundleName")
            except (OSError, plistlib.InvalidFileException, ValueError, AttributeError):
                try:  # the system's own apps keep every language in one table
                    with open(bundle / "Contents/Resources/InfoPlist.loctable", "rb") as file:
                        table = plistlib.load(file).get("es") or {}
                    spanish = table.get("CFBundleDisplayName") or table.get("CFBundleName")
                except (OSError, plistlib.InvalidFileException, ValueError, AttributeError):
                    pass
            found[ident] = {"id": ident, "name": str(spanish or name)[:80], "aliases": sorted({str(name)[:80], bundle.stem} - {str(spanish or name)[:80]})}
    return sorted(found.values(), key=lambda a: a["name"].lower())


def _linux_apps() -> list[dict]:
    found: dict[str, dict] = {}
    for root in (Path("/usr/share/applications"), Path.home() / ".local/share/applications", Path("/var/lib/flatpak/exports/share/applications")):
        for entry in list(root.glob("*.desktop"))[:800] if root.is_dir() else []:
            parser = configparser.ConfigParser(interpolation=None, strict=False)
            try:
                parser.read(entry, encoding="utf-8")
                section = parser["Desktop Entry"]
            except (configparser.Error, KeyError, OSError, UnicodeDecodeError):
                continue
            if section.get("NoDisplay", "false").lower() == "true" or section.get("Type") != "Application":
                continue
            found[entry.stem] = {"id": entry.stem, "name": section.get("Name", entry.stem)[:80]}
    return sorted(found.values(), key=lambda a: a["name"].lower())


def _windows_roots() -> list[Path]:
    roots = []
    for var in ("APPDATA", "PROGRAMDATA"):
        val = os.environ.get(var)
        if val:
            roots.append(Path(val) / "Microsoft/Windows/Start Menu/Programs")
    return roots


def _windows_apps() -> list[dict]:
    skip = re.compile(r"\b(uninstall|desinstalar|quitar|readme|leeme|help|ayuda|manual|website)\b", re.I)
    found: dict[str, dict] = {}
    paths: dict[str, Path] = {}
    seen_names: set[str] = set()
    for root in _windows_roots():
        if not root.is_dir() or root.is_symlink() or root.is_junction():
            continue
        real_root = root.resolve()
        for current, dirs, files in os.walk(root):
            current_path = Path(current)
            depth = len(current_path.relative_to(root).parts)
            dirs[:] = [
                d for d in dirs
                if depth < 3 and not d.startswith(".") and not (current_path / d).is_symlink() and not (current_path / d).is_junction()
            ]
            for fname in files:
                if not fname.lower().endswith(".lnk") or fname.startswith("."):
                    continue
                lnk = current_path / fname
                try:
                    if lnk.is_symlink() or lnk.is_junction() or not lnk.is_file() or real_root not in lnk.resolve().parents:
                        continue
                except OSError:
                    continue
                name = lnk.stem.strip()[:80]
                if not name or skip.search(name) or name.lower() in seen_names:
                    continue
                slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "app"
                digest = hashlib.sha1(str(lnk).lower().encode("utf-8")).hexdigest()[:10]
                ident = f"win.{slug}.{digest}"
                seen_names.add(name.lower())
                found[ident] = {"id": ident, "name": name}
                paths[ident] = lnk
                if len(found) >= 600:
                    break
            if len(found) >= 600:
                break
    _win_paths.clear()
    _win_paths.update(paths)
    return sorted(found.values(), key=lambda a: a["name"].lower())


def _open_windows_shortcut(ident: str) -> None:
    lnk = _win_paths.get(ident)
    if not lnk or lnk.suffix.lower() != ".lnk" or lnk.is_symlink() or lnk.is_junction() or not lnk.is_file():
        raise AppsError("No se pudo abrir la aplicación.")
    roots = [r.resolve() for r in _windows_roots() if r.is_dir()]
    if not any(r in lnk.resolve().parents for r in roots):
        raise AppsError("No se pudo abrir la aplicación.")
    os.startfile(str(lnk))  # noqa: S606 - verified Start Menu .lnk from closed catalog


def installed() -> list[dict]:
    hit = _cache.get("apps")
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    apps = _mac_apps() if sys.platform == "darwin" else _windows_apps() if sys.platform == "win32" else _linux_apps() if sys.platform.startswith("linux") else []
    _cache["apps"] = (time.monotonic(), apps)
    return apps


def allowed(connection: sqlite3.Connection) -> list[str]:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    saved = json.loads(row["value"]) if row else {}
    return [a for a in saved.get("allowed", []) if isinstance(a, str)]


def save_allowed(connection: sqlite3.Connection, ids: list[str]) -> list[str]:
    known = {a["id"] for a in installed()}
    clean = sorted({i for i in ids if i in known})[:200]
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                           (SETTING, json.dumps({"allowed": clean})))
    return clean


def open_app(connection: sqlite3.Connection, ident: str, confirmed: bool) -> str:
    app = next((a for a in installed() if a["id"] == ident), None)
    if not app:
        raise AppsError("Esa aplicación no está instalada en este equipo.", 404)
    if ident not in allowed(connection) and not confirmed:
        raise AppsError(f"«{app['name']}» no está en tu lista de apps permitidas: confirma antes de abrirla.", 409)
    if sys.platform == "win32":
        try:
            _open_windows_shortcut(ident)
        except OSError as error:
            raise AppsError("No se pudo abrir la aplicación.") from error
        return f"Abierta {app['name']}."
    command = ["/usr/bin/open", "-b", ident] if sys.platform == "darwin" else ["gtk-launch", ident]
    try:
        done = subprocess.run(command, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AppsError("No se pudo abrir la aplicación.") from error
    if done.returncode != 0:
        raise AppsError("No se pudo abrir la aplicación.")
    return f"Abierta {app['name']}."
