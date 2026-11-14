"""A raw e-mail turned into what AgoraOne keeps: addresses, subject, date, readable text and the list of
attachments. HTML becomes plain text with the standard library; nothing in the message is executed,
fetched or followed (remote images, links and scripts stay as text or are dropped)."""

import email
import email.policy
import email.utils
import re
from dataclasses import dataclass, field
from datetime import UTC
from email.message import EmailMessage
from html.parser import HTMLParser

MAX_BODY = 64 * 1024
_SPACES = re.compile(r"[ \t ]+")
_BLANKS = re.compile(r"\n{3,}")
_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class _Text(HTMLParser):
    """Visible text of an HTML body; scripts, styles and the head are skipped, blocks become line breaks."""

    SKIP = {"script", "style", "head", "title", "noscript", "template"}
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "section", "article", "hr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipping += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skipping:
            self.skipping -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skipping:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _Text()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # malformed HTML: keep what was read
        pass
    return "".join(parser.parts)


def tidy(text: str) -> str:
    text = _CONTROLS.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
    lines = [_SPACES.sub(" ", line).strip() for line in text.split("\n")]
    return _BLANKS.sub("\n\n", "\n".join(lines)).strip()


@dataclass
class Parsed:
    message_id: str | None = None
    in_reply_to: str | None = None
    from_address: str | None = None
    from_name: str | None = None
    to_addresses: list[str] = field(default_factory=list)
    cc_addresses: list[str] = field(default_factory=list)
    subject: str | None = None
    sent_at: str | None = None
    body: str = ""
    truncated: bool = False
    attachments: list[dict] = field(default_factory=list)


def _header(message: EmailMessage, name: str) -> str | None:
    try:
        value = message.get(name)
    except Exception:  # a header the policy cannot decode
        return None
    return tidy(str(value))[:998] if value is not None else None


def _addresses(message: EmailMessage, name: str) -> list[tuple[str, str]]:
    try:  # the header parser itself can fail on odd groups ("g:;@x") or broken encodings
        pairs = email.utils.getaddresses([str(value) for value in message.get_all(name, [])])
    except Exception:
        return []
    return [(tidy(n)[:200], a.strip().lower()[:254]) for n, a in pairs if "@" in a]


def _date(message: EmailMessage) -> str | None:
    value = message.get("Date")
    if not value:
        return None
    try:
        moment = email.utils.parsedate_to_datetime(str(value))
    except (TypeError, ValueError, IndexError):
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _text_of(part) -> str:
    try:
        content = part.get_content()
    except Exception:  # unknown charset or broken encoding: decode leniently
        payload = part.get_payload(decode=True) or b""
        content = payload.decode("utf-8", errors="replace")
    return content if isinstance(content, str) else ""


def parse(raw: bytes) -> Parsed:
    message = email.message_from_bytes(raw, policy=email.policy.default)
    parsed = Parsed()
    parsed.message_id = _header(message, "Message-ID")
    parsed.in_reply_to = _header(message, "In-Reply-To")
    sender = _addresses(message, "From")
    if sender:
        parsed.from_name, parsed.from_address = sender[0][0] or None, sender[0][1]
    parsed.to_addresses = [a for _, a in _addresses(message, "To")][:50]
    parsed.cc_addresses = [a for _, a in _addresses(message, "Cc")][:50]
    parsed.subject = _header(message, "Subject")
    parsed.sent_at = _date(message)
    try:
        body = message.get_body(preferencelist=("plain", "html"))
    except Exception:
        body = None
    if body is not None:
        text = _text_of(body)
        if body.get_content_type() == "text/html":
            text = html_to_text(text)
        text = tidy(text)
        if len(text) > MAX_BODY:
            text, parsed.truncated = text[:MAX_BODY], True
        parsed.body = text
    for index, part in enumerate(message.walk()):
        if part.is_multipart() or part is body:
            continue
        try:
            name = part.get_filename()
            if not name and part.get_content_disposition() != "attachment":
                continue
            payload = part.get_payload(decode=True) or b""
            kind = part.get_content_type()
        except Exception:  # a part whose headers cannot be read is listed without a name
            name, payload, kind = None, b"", "application/octet-stream"
        parsed.attachments.append({"name": tidy(name or "adjunto")[:200], "type": kind, "bytes": len(payload), "part": index})
    parsed.attachments = parsed.attachments[:50]
    return parsed
