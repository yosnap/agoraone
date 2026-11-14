"""Finding a payment notice's invoice and reading it, all on this Mac and without any model.

The invoice may be attached (a PDF), linked from the message (downloaded only after the user confirms,
from a public https address, as a PDF of bounded size) or only on the supplier's website (opened in the
user's browser). Its text is read by the same isolated extractor as the library (no network, no writes),
and local rules find the tax id, date and total, which are checked against the payment notice."""

import email
import email.policy
import ipaddress
import re
import socket
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .fiscal import MAX_FILE, amount

_URL = re.compile(r"https://[^\s<>\"')\]]{4,500}", re.I)
_INVOICE_WORDS = re.compile(r"invoice|factura|facture|rechnung|fattura|receipt|recibo|download|descarga|pdf", re.I)
_TAX_ID = re.compile(r"\b(?:ES)?([A-HJNP-SUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b|\b((?:EU|GB|IE|FR|DE|NL|LU|IT|PT)[0-9A-Z]{8,12})\b")
_TOTAL = re.compile(r"(?:total(?:\s+a\s+pagar|\s+factura|\s+amount|\s+due|\s+paid)?|importe\s+total|amount\s+paid|gesamt(?:betrag)?)"
                    r"[^\d\n]{0,25}(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))", re.I)
_DATE = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)|(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)")
_CURRENCY = re.compile(r"(€|EUR|USD|\$|GBP|£)")
EXTRACT_SECONDS = 20
SANDBOX = "(version 1)(allow default)(deny network*)(deny file-write* (subpath \"/\"))(allow file-write* (literal \"/dev/null\"))(deny process-fork)"


class ExtractError(RuntimeError):
    pass


def attachment(raw: bytes, part: int) -> tuple[str, bytes]:
    """The attachment at position `part` of a message (as listed when it was read)."""
    message = email.message_from_bytes(raw, policy=email.policy.default)
    for index, item in enumerate(message.walk()):
        if index == part and not item.is_multipart():
            return item.get_filename() or "factura.pdf", item.get_payload(decode=True) or b""
    raise ExtractError("Ese adjunto ya no está en el correo.")


def links(body: str | None) -> list[str]:
    """https links of the message that look like an invoice download, at most five, in order."""
    found = []
    for match in _URL.finditer(body or ""):
        url = match[0].rstrip(".,;")
        line_start = (body or "").rfind("\n", 0, match.start()) + 1
        around = (body or "")[max(line_start, match.start() - 60): match.start()]  # the words just before it, on its line
        if _INVOICE_WORDS.search(url) or _INVOICE_WORDS.search(around):
            if url not in found:
                found.append(url)
    return found[:5]


def _public(host: str) -> bool:
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    except OSError:
        return False
    return bool(addresses) and all(ipaddress.ip_address(a.split("%")[0]).is_global for a in addresses)


def download(url: str, http=None) -> bytes:
    """A linked invoice, only after the user confirmed: public https host, no redirects to elsewhere, PDF only."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or not _public(parsed.hostname):
        raise ExtractError("Ese enlace no es una dirección https pública.")
    get = http or (lambda u: httpx.get(u, timeout=20, follow_redirects=False, trust_env=False))
    response = get(url)
    if response.status_code != 200:
        raise ExtractError("La web del proveedor no entregó el archivo: ábrela en el navegador.")
    data = response.content[: MAX_FILE + 1]
    if len(data) > MAX_FILE or not data.startswith(b"%PDF-"):
        raise ExtractError("El enlace no lleva a un PDF: probablemente hay que entrar en la web del proveedor.")
    return data


def pdf_text(data: bytes, runner=subprocess.run) -> str:
    """Text of a PDF through the isolated extractor (sandboxed on macOS); empty when it cannot be read."""
    command = [sys.executable, "-I", str(Path(__file__).with_name("extract.py")), "pdf"]  # -I: no paths from the environment
    if sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").exists():
        command = ["/usr/bin/sandbox-exec", "-p", SANDBOX, *command]
    try:
        done = runner(command, input=data, capture_output=True, timeout=EXTRACT_SECONDS, env={})
    except (subprocess.TimeoutExpired, OSError):
        return ""
    if done.returncode != 0:
        return ""
    import json

    try:
        return json.loads(done.stdout)["content"]
    except (ValueError, KeyError, TypeError):
        return ""


def _dates(text: str) -> list[str]:
    found = []
    for y, m, d, d2, m2, y2 in _DATE.findall(text):
        year, month, day = (y, m, d) if y else (y2, m2, d2)
        if 1 <= int(month) <= 12 and 1 <= int(day) <= 31 and 2000 <= int(year) <= 2100:
            found.append(f"{year}-{int(month):02d}-{int(day):02d}")
    return found


def fields(text: str) -> dict:
    """What local rules find in an invoice's text: tax id, date, total and currency (any may be missing)."""
    tax = _TAX_ID.search(text.upper())
    totals = [amount(m) for m in _TOTAL.findall(text)]
    currency = _CURRENCY.search(text)
    dates = _dates(text)
    symbol = currency[1] if currency else "€"
    return {
        "taxId": (tax[1] or tax[2]) if tax else None,
        "total": next((t for t in reversed(totals) if t), None),
        "issuedOn": dates[0] if dates else None,
        "currency": {"€": "EUR", "$": "USD", "£": "GBP"}.get(symbol, symbol),
    }


def doubts(found: dict, notice: dict) -> list[str]:
    """What does not match between the invoice and its payment notice, said plainly."""
    result = []
    if not found.get("taxId"):
        result.append("No aparece el NIF del proveedor.")
    paid = [amount(a) for a in notice.get("amounts", []) if amount(a)]
    if not found.get("total"):
        result.append("No se encontró el total en la factura.")
    elif paid and found["total"] not in paid:
        result.append(f"El total de la factura ({found['total']}) no coincide con el del aviso ({', '.join(paid)}).")
    if not found.get("issuedOn"):
        result.append("No se encontró la fecha de la factura.")
    if found.get("currency") and found["currency"] != "EUR":
        result.append(f"Factura en {found['currency']}: revisa el cambio a euros.")
    return result
