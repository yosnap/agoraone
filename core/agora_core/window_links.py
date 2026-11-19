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
    """AgoraOne's own host, which shares its cookies whatever the port, or another name for this machine: any loopback
    or unspecified address (127.x, ::1, 0.0.0.0, :: and those written as IPv4 inside IPv6), `localhost.` with its final
    dot and any `*.localhost`. Plain `localhost` is another host for cookies and is not AgoraOne's."""
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        name = host.rstrip(".")
        return (name != host and name == "localhost") or name.endswith(".localhost")
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_unspecified


def open_in_browser(url: str) -> bool:
    """The system's browser (Safari, Edge, Firefox…) on macOS, Windows and Linux; never through a shell."""
    try:
        return bool(webbrowser.open(url, new=2))
    except webbrowser.Error:
        return False
