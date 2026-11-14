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
import threading
import time
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .fiscal import MAX_FILE, amount

_URL = re.compile(r"https://[^\s<>\"')\]]{4,500}", re.I)
_INVOICE_WORDS = re.compile(r"invoice|factura|facture|rechnung|fattura|receipt|recibo|download|descarga|pdf", re.I)
_TAX_ID = re.compile(r"\b(?:ES)?([A-HJNP-SUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b|\b((?:EU|GB|IE|FR|DE|NL|LU|IT|PT)[0-9A-Z]{8,12})\b")
_TOTAL = re.compile(r"(?:total(?!\s*(?:de\s+)?(?:iva|vat|tax|impuestos?|igic))(?:\s+a\s+pagar|\s+factura|\s+amount|\s+due|\s+paid)?|importe\s+total|amount\s+paid|gesamt(?:betrag)?)"
                    r"[^\d\n]{0,25}(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))", re.I)
_DATE = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)|(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)")
_CURRENCY = re.compile(r"(€|EUR|USD|\$|GBP|£)")
EXTRACT_SECONDS = 20
# Like the library's extractor: no network, no writes, no child processes, and no reading the contents of
# personal folders, other disks or temporary folders, except this Python and the core's own folder.
_SANDBOX_BASE = ("(version 1)(allow default)(deny network*)(deny file-write* (subpath \"/\"))(allow file-write* (literal \"/dev/null\"))"
                 "(deny process-fork)(deny file-read-data (subpath \"/Users\") (subpath \"/Volumes\") (subpath \"/private/var/folders\") (subpath \"/private/tmp\"))")
_RUNNING = threading.Semaphore(4)


def _quote(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace('"', '\\"')


def sandbox_profile() -> str:
    readable = {Path(__file__).resolve().parent, Path(sys.prefix).resolve(), Path(sys.base_prefix).resolve(), Path(sys.executable).resolve().parent}
    return _SANDBOX_BASE + "".join(f'(allow file-read-data (subpath "{_quote(p)}"))' for p in sorted(readable))


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


def download(url: str, http=None, deadline: float = 30) -> bytes:
    """A linked invoice, only after the user confirmed: public https host, no redirects, PDF only, at most
    MAX_FILE bytes and `deadline` seconds in all."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or not _public(parsed.hostname):
        raise ExtractError("Ese enlace no es una dirección https pública.")
    if http is not None:  # tests: a callable returning (status, bytes)
        status, data = http(url)
    else:
        started, chunks, size = time.monotonic(), [], 0
        try:
            with httpx.stream("GET", url, timeout=20, follow_redirects=False, trust_env=False) as response:
                status = response.status_code
                if status == 200:
                    if int(response.headers.get("content-length") or 0) > MAX_FILE:
                        raise ExtractError("El archivo del enlace es demasiado grande.")
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        chunks.append(chunk)
                        if size > MAX_FILE or time.monotonic() - started > deadline:
                            raise ExtractError("El archivo del enlace es demasiado grande o tarda demasiado.")
        except httpx.HTTPError as error:
            raise ExtractError("No se pudo descargar del enlace: ábrelo en el navegador.") from error
        data = b"".join(chunks)
    if status != 200:
        raise ExtractError("La web del proveedor no entregó el archivo: ábrela en el navegador.")
    if not data.startswith(b"%PDF-"):
        raise ExtractError("El enlace no lleva a un PDF: probablemente hay que entrar en la web del proveedor.")
    return data


def pdf_text(data: bytes, runner=subprocess.run) -> str:
    """Text of a PDF through the isolated extractor (sandboxed on macOS); empty when it cannot be read."""
    command = [sys.executable, "-I", str(Path(__file__).with_name("extract.py")), "pdf"]  # -I: no paths from the environment
    if sys.platform == "darwin":
        if not Path("/usr/bin/sandbox-exec").exists():
            return ""  # never parse a PDF from the mail without the sandbox
        command = ["/usr/bin/sandbox-exec", "-p", sandbox_profile(), *command]
    try:
        with _RUNNING:
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


def _dates(text: str) -> list[tuple[str, bool]]:
    """Valid dates in the text, each with whether it is ambiguous (day and month both 12 or less)."""
    found = []
    for y, m, d, d2, m2, y2 in _DATE.findall(text):
        year, month, day = (y, m, d) if y else (y2, m2, d2)
        try:
            parsed = date(int(year), int(month), int(day))
        except ValueError:
            continue
        if 2000 <= parsed.year <= 2100:
            found.append((parsed.isoformat(), not y and int(d2) <= 12 and int(m2) <= 12 and d2 != m2))
    return found


def fields(text: str) -> dict:
    """What local rules find in an invoice's text: tax id, date, total and currency (any may be missing)."""
    tax = _TAX_ID.search(text.upper())
    totals = [amount(m) for m in _TOTAL.findall(text)]
    if not any(totals):  # receipts without a «Total» line: the largest amount written with its currency
        marked = [amount(a or b) for a, b in _MONEY_NEAR.findall(text)]
        marked = [m for m in marked if m]
        totals = [max(marked, key=float)] if marked else []
    currency = _CURRENCY.search(text)
    dates = _dates(text)
    symbol = currency[1] if currency else "€"
    return {
        "taxId": (tax[1] or tax[2]) if tax else None,
        "total": next((t for t in reversed(totals) if t), None),
        "issuedOn": dates[0][0] if dates else None,
        "dateAmbiguous": bool(dates and dates[0][1]),
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
    elif not paid:
        result.append("El aviso no trae un importe con el que cotejar el total.")
    elif paid and found["total"] not in paid:
        result.append(f"El total de la factura ({found['total']}) no coincide con el del aviso ({', '.join(paid)}).")
    if not found.get("issuedOn"):
        result.append("No se encontró la fecha de la factura.")
    elif found.get("dateAmbiguous"):
        result.append("La fecha puede leerse como día/mes o mes/día: compruébala.")
    if found.get("currency") and found["currency"] != "EUR":
        result.append(f"Factura en {found['currency']}: revisa el cambio a euros.")
    return result


_NUM = r"(\d{1,3}(?:[.\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)"
_BASE = re.compile(r"(?:base\s+imponible|subtotal|importe\s+neto|total\s+sin\s+iva|net\s+amount)[^\d\n]{0,25}" + _NUM, re.I)
_VAT_AMOUNT = re.compile(r"(?:importe\s+(?:total\s+)?del?\s+IVA|cuota\s+(?:de\s+)?IVA|total\s+(?:del\s+)?IVA|IVA\s+total|total\s+VAT|VAT\s+amount|total\s+tax)[^\d\n]{0,20}" + _NUM, re.I)
_MONEY_NEAR = re.compile(r"(?:[€$£]|EUR|USD|GBP)\s?" + _NUM + r"|" + _NUM + r"\s?(?:[€$£]|EUR|USD|GBP)")
_VAT = re.compile(r"(?:IVA|VAT|TVA|MwSt)[^\d\n%]{0,12}(\d{1,2}(?:[.,]\d{1,2})?)\s?%[^\d\n]{0,20}" + _NUM, re.I)
_IRPF = re.compile(r"(?:IRPF|retenci[oó]n)[^\d\n%]{0,12}-?\s?(\d{1,2}(?:[.,]\d{1,2})?)\s?%[^\d\n]{0,20}-?\s?" + _NUM, re.I)
_NUMBER = re.compile(r"(?:factura|invoice|n[º°o]\.?\s*de\s*factura)\s*(?:n[º°o.]*|number|num\.?|#)?\s*[:\-]?\s*([A-Z]{0,4}[\-/]?\d[\w\-/]{1,20})", re.I)


def breakdown(text: str) -> dict:
    """Base, VAT and withholding of an invoice's text, by local rules (any may be missing)."""
    base = _BASE.search(text)
    vat = _VAT.search(text)
    vat_amount = _VAT_AMOUNT.search(text)
    irpf = _IRPF.search(text)
    number = _NUMBER.search(text)
    rate = lambda found: round(float(found[1].replace(",", ".")) / 100, 4) if found else None  # noqa: E731
    vat_value = amount(vat[2]) if vat else amount(vat_amount[1]) if vat_amount else None
    vat_rate = rate(vat)
    if vat_rate is None and vat_value is not None and base and amount(base[1]) and float(amount(base[1])) > 0:
        vat_rate = round(float(vat_value) / float(amount(base[1])), 2)
    tax_ids = []
    for found in _TAX_ID.finditer(text.upper()):
        tax_id = found[1] or found[2]
        if tax_id not in tax_ids:
            tax_ids.append(tax_id)
    return {"taxIds": tax_ids[:4], "base": amount(base[1]) if base else None, "vatRate": vat_rate, "vat": vat_value,
            "withholdingRate": rate(irpf), "withholding": amount(irpf[2]) if irpf else None, "number": number[1] if number else None}
