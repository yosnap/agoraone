"""What the add-on windows of the desktop app (Central, Mi fábrica) share in the core: checking a link to another
site before the system's browser opens it, and telling AgoraOne's own host."""

import ipaddress
import re
import webbrowser
from urllib.parse import urlsplit

MAX_URL = 2000
_HOST = re.compile(r"[a-z0-9.-]{1,253}|[0-9a-f:.]{2,45}")


def external_url(value: object) -> str | None:
    """A web address (http or https) with a host and no user or password, printable ASCII (WebKit hands them
    percent-encoded)."""
    if not isinstance(value, str) or not 8 < len(value) <= MAX_URL or not all(c.isascii() and c.isprintable() and not c.isspace() for c in value):
        return None
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        parts.port  # noqa: B018 - raises on a port that is not a number
    except ValueError:
        return None
    if parts.scheme not in ("https", "http") or parts.username is not None or parts.password is not None or not _HOST.fullmatch(host):
        return None
    return value


def agora_host(url: str) -> bool:
    """127.x or ::1: AgoraOne's own host, which shares its cookies whatever the port."""
    try:
        return ipaddress.ip_address(urlsplit(url).hostname or "").is_loopback
    except ValueError:
        return False


def open_in_browser(url: str) -> bool:
    """The system's browser (Safari, Edge, Firefox…) on macOS, Windows and Linux; never through a shell."""
    try:
        return bool(webbrowser.open(url, new=2))
    except webbrowser.Error:
        return False
