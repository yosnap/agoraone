"""Text of an imported PDF or DOCX, run as its own process: bytes on stdin, ``{"content": ...}`` on stdout.

The server starts it without credentials, sandboxed (no network, no file writes, no child processes) and
with a time limit, so a flaw in a parser stays contained. It never receives a path. Any failure exits 1
without output. Same limits as before: 5 MiB in, 100 PDF pages, 24 KiB of text, and for DOCX a ZIP of at
most 1000 entries and 16 MiB unpacked, without encryption or repeated names. No OCR.
"""

import io
import json
import re
import sys
import zipfile

MAX_INPUT = 5 * 1024 * 1024
MAX_TEXT = 24 * 1024
MAX_PAGES = 100
MAX_ENTRIES = 1000
MAX_UNPACKED = 16 * 1024 * 1024
CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class Refused(Exception):
    pass


def _check(condition: bool) -> None:
    if not condition:
        raise Refused


def pdf_text(data: bytes) -> str:
    _check(data.startswith(b"%PDF-"))
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    _check(not reader.is_encrypted and len(reader.pages) <= MAX_PAGES)
    content = ""
    for page in reader.pages:
        content += (page.extract_text() or "") + "\n"
        _check(len(content.encode()) <= MAX_TEXT)
    return content


def _invoice_text(data: bytes) -> str:
    _check(data.startswith(b"%PDF-"))
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    _check(not reader.is_encrypted)
    content = ""
    for page in reader.pages[:10]:  # the figures of an invoice are on its first pages
        content += (page.extract_text() or "") + "\n"
        if len(content) > MAX_TEXT:
            break
    return content


def validate_docx(data: bytes) -> None:
    """The ZIP limits, counting what is really unpacked, not what the entries declare."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        _check(len(entries) <= MAX_ENTRIES and len(set(names)) == len(names))
        _check(sum(entry.file_size for entry in entries) <= MAX_UNPACKED)
        _check(not any(entry.flag_bits & 0x1 for entry in entries))
        unpacked = 0
        for entry in entries:
            with archive.open(entry) as stream:
                while chunk := stream.read(64 * 1024):
                    unpacked += len(chunk)
                    _check(unpacked <= MAX_UNPACKED)
        _check("word/document.xml" in names and "[Content_Types].xml" in names)


def docx_text(data: bytes) -> str:
    validate_docx(data)
    from docx.oxml.ns import qn
    from docx.oxml.parser import parse_xml

    # The main part straight from the validated ZIP (a document without package relationships still reads),
    # parsed with python-docx's parser, which never resolves entities.
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        body = parse_xml(archive.read("word/document.xml"))
    # Every paragraph in document order, tables included, one blank line apart (as the former extractor).
    paragraphs = ("".join(text.text or "" for text in paragraph.iter(qn("w:t"))) for paragraph in body.iter(qn("w:p")))
    return "\n\n".join(paragraphs)


def extract(kind: str, data: bytes) -> str:
    if kind == "invoice":
        # An invoice for the fiscal register: control characters some generators leave in the text are dropped
        # (the library refuses them), and only what fits is kept.
        _check(0 < len(data) <= MAX_INPUT)
        content = CONTROLS.sub(" ", _invoice_text(data)).strip()
        _check(bool(content))
        return content[:MAX_TEXT]
    _check(0 < len(data) <= MAX_INPUT)
    content = (pdf_text(data) if kind == "pdf" else docx_text(data)).strip()
    _check(bool(content) and len(content.encode()) <= MAX_TEXT and not CONTROLS.search(content))
    return content


def main() -> int:
    kind = sys.argv[1] if len(sys.argv) > 1 else ""
    if kind not in ("pdf", "docx", "invoice"):
        return 1
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    try:
        content = extract(kind, data)
    except Exception:  # noqa: BLE001 - any parser failure is the same refusal, with no details
        return 1
    sys.stdout.write(json.dumps({"content": content}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
