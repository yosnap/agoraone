"""Opening applications when the user asks (1.5): the apps installed on this computer, read from where each
system keeps them (macOS bundles in the Applications folders, Linux `.desktop` entries; Windows not yet), and
the user's list of the ones Watson may open without asking. An app is always opened by its identifier from
that list (a bundle id, a desktop id), never by a name or command typed by anyone; apps are only ever
opened, never closed or changed."""

import configparser
import json
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


def installed() -> list[dict]:
    hit = _cache.get("apps")
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    apps = _mac_apps() if sys.platform == "darwin" else _linux_apps() if sys.platform.startswith("linux") else []
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
    command = ["/usr/bin/open", "-b", ident] if sys.platform == "darwin" else ["gtk-launch", ident]
    try:
        done = subprocess.run(command, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AppsError("No se pudo abrir la aplicación.") from error
    if done.returncode != 0:
        raise AppsError("No se pudo abrir la aplicación.")
    return f"Abierta {app['name']}."
