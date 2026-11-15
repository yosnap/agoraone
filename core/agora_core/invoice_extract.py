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
_TAX_ID = re.compile(r"\b(?:ES)?([A-HJNP-SUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b|\b((?:EU|GB|IE|FR|DE|NL|LU|IT|PT)(?=[0-9A-Z]*\d)[0-9A-Z]{8,12})\b")
_TOTAL = re.compile(r"(?:total(?!\s*(?:de\s+)?(?:iva|vat|tax|impuestos?|igic))(?:\s+a\s+pagar|\s+factura|\s+amount|\s+due|\s+paid)?|importe\s+total|amount\s+paid|gesamt(?:betrag)?)"
                    r"[^\d\n]{0,25}(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))", re.I)
_DATE = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)|(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)")
_TWO_DECIMALS = r"(?<![\d.,])(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,3}(?:[. ]\d{3})+,\d{2}|\d+[.,]\d{2})(?![\d.,]*\s?%)(?!\d)"
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
    command = [sys.executable, "-I", str(Path(__file__).with_name("extract.py")), "invoice"]  # -I: no paths from the environment
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


_MONTHS = {"ene": 1, "jan": 1, "feb": 2, "mar": 3, "abr": 4, "apr": 4, "may": 5, "jun": 6, "jul": 7, "ago": 8, "aug": 8,
           "sep": 9, "set": 9, "oct": 10, "nov": 11, "dic": 12, "dec": 12}
_WORD_DATE = re.compile(r"(?<!\d)(\d{1,2})(?:st|nd|rd|th)?(?:\s+de)?\s+([a-zA-Zé]{3,10})\.?(?:\s+de)?,?\s+(\d{4})(?!\d)|"
                        r"\b([a-zA-Z]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)")


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
    for d, month, y, month2, d2, y2 in _WORD_DATE.findall(text):  # «7 abr 2026», «7 de abril de 2026», «Apr 7, 2026»
        number = _MONTHS.get((month or month2)[:3].casefold())
        try:
            parsed = date(int(y or y2), number, int(d or d2)) if number else None
        except ValueError:
            parsed = None
        if parsed and 2000 <= parsed.year <= 2100:
            found.append((parsed.isoformat(), False))
    return sorted(found, key=lambda item: text.find(item[0]) if item[0] in text else 0)


def fields(text: str) -> dict:
    """What local rules find in an invoice's text: tax id, date, total and currency (any may be missing)."""
    tax = _TAX_ID.search(text.upper())
    totals = []
    for match in _TOTAL.finditer(text):
        # «Total: 8.00 70.78 EUR»: the figure next to the currency, at the end of the line, is the total.
        line_end = text.find("\n", match.end())
        rest = text[match.end(): line_end if line_end >= 0 else None]
        later = [amount(a) for a in re.findall(_TWO_DECIMALS, rest)]
        totals.append(later[-1] if later else amount(match[1]))
    if not any(totals):
        # Labels and amounts in separate columns, or a receipt without a «Total» line: among the amounts written
        # with their currency (and two decimals: «1.579 €/l» is a price per litre), the one written most often,
        # the largest on a tie; never the company's share capital.
        lines = [line for line in text.splitlines() if not re.search(r"capital\s+social|share\s+capital|registro\s+mercantil|registro\s+comercial", line, re.I)]
        found = [a or b for line in lines for a, b in _MONEY_NEAR.findall(line)]
        two = [amount(m) for m in found if re.search(r"[.,]\d{2}$", m)]
        marked = [m for m in (two or [amount(m) for m in found]) if m]
        if marked:
            counts = {m: marked.count(m) for m in marked}
            totals = [max(counts, key=lambda m: (counts[m], float(m)))]
    currency = _CURRENCY.search(text)
    dates = _dates(text)
    symbol = currency[1] if currency else "€"
    return {
        "taxId": (tax[1] or tax[2]) if tax else None,
        "total": next((t for t in reversed(totals) if t), None),
        "issuedOn": dates[0][0] if dates else None,
        "dates": sorted({d for d, _ in dates})[:12],
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


# An amount: 1,234.56 (English) before 1.234,56 or 1 234,56 (Spanish), then 12,50 / 12.50, then 12; never a
# percentage, and thousands are never split across lines.
_NUM = (r"(?<![\d.,])(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,3}(?:[. \u00a0]\d{3})+(?:,\d{2})?|\d+[.,]\d{2}|\d+)(?![\d.,]*\s?%)(?![\d])")
_GAP = r"(?:[^\d\n]|\(\d{1,2}(?:[.,]\d+)?\s?%\))"
# The total needs decimals or thousands (so «Total 3 artículos» is not read as 3 €).
_TOTAL = re.compile(r"(?:total(?!\s*(?:de\s+)?(?:iva|vat|tax|impuestos?|igic))(?:\s+a\s+pagar|\s+factura|\s+amount|\s+due|\s+paid)?"
                    r"|importe\s+total|amount\s+paid|gesamt(?:betrag)?)[^\d\n]{0,25}"
                    r"(?<![\d.,])(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,3}(?:[. \u00a0]\d{3})+(?:,\d{2})?|\d+[.,]\d{2})(?![\d.,]*\s?%)(?!\d)", re.I)
_BASE = re.compile(r"(?:base\s+imponible|subtotal|importe\s+neto|total\s+sin\s+iva|net\s+amount)" + _GAP + r"{0,25}" + _NUM, re.I)
_VAT_AMOUNT = re.compile(r"(?:importe\s+(?:total\s+)?del?\s+IVA|cuota\s+(?:de\s+)?IVA|total\s+(?:del\s+)?IVA|IVA\s+total|total\s+VAT|VAT\s+amount|total\s+tax)[^\d\n]{0,20}" + _NUM, re.I)
_MONEY_NEAR = re.compile(r"(?:[€$£]|EUR|USD|GBP)\s?" + _NUM + r"|" + _NUM + r"\s?(?:[€$£]|EUR|USD|GBP)")
_VAT_RATE = re.compile(r"(?:I\.?V\.?A\.?|VAT|TVA|MwSt)[^\d\n%]{0,8}\(?(\d{1,2}(?:[.,]\d{1,2})?)\s?%", re.I)
_VAT = re.compile(r"(?:I\.?V\.?A\.?|VAT|TVA|MwSt)[^\d\n%]{0,12}(\d{1,2}(?:[.,]\d{1,2})?)\s?%[^\d\n]{0,20}" + _NUM, re.I)
_IRPF = re.compile(r"(?:IRPF|retenci[oó]n)[^\d\n%]{0,12}-?\s?(\d{1,2}(?:[.,]\d{1,2})?)\s?%[^\d\n]{0,20}-?\s?" + _NUM, re.I)
_NUMBER = re.compile(r"(?:factura|invoice|n[º°o]\.?\s*de\s*factura)\s*(?:n[º°o.]*|number|num\.?|#)?\s*[:\-]?\s*(?!\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})([A-Z]{0,4}[\-/]?\d[\w\-/]{0,20})", re.I)


VERSION = 10  # bump when the reading rules change: files read with older rules are read again


_LEGAL = re.compile(r"\b(limited|ltd|llc|inc|gmbh|s\.?\s?l\.?u?|s\.?\s?a\.?u?|b\.?v\.?|sas|sarl|ag|plc|oy|ab|d\.o\.o\.|corp(oration)?)\b\.?", re.I)


def _looks_like_name(line: str) -> bool:
    if not 3 <= len(line) <= 80 or "@" in line or re.search(r"https?:|www\.|n[uú]mero de iva|\bnif\b|\bcif\b|\d{4,}|descripci|precio|cantidad|^\s*(?:facturar a|bill to|cliente|datos del cliente)\s*:?\s*$|\bcant\.|importe|total|\biva\b", line, re.I):
        return False
    return sum(c.isdigit() for c in line) <= 2 and any(c.isalpha() for c in line)


def breakdown(text: str) -> dict:
    """Base, VAT and withholding of an invoice's text, by local rules (any may be missing)."""
    base = _BASE.search(text)
    vat = _VAT.search(text)
    vat_amount = _VAT_AMOUNT.search(text)
    irpf = _IRPF.search(text)
    number = _NUMBER.search(text)
    rate = lambda found: round(float(found[1].replace(",", ".")) / 100, 4) if found else None  # noqa: E731
    vat_value = amount(vat[2]) if vat else amount(vat_amount[1]) if vat_amount else None
    vat_rate = rate(vat) if vat else rate(_VAT_RATE.search(text))
    base_value = amount(base[1]) if base else None
    if base_value and vat_rate is not None:
        expected = round(float(base_value) * vat_rate, 2)
        if vat_value is None or abs(float(vat_value) - expected) > max(0.05, expected * 0.02):
            vat_value = f"{expected:.2f}"  # «IVA 21 % sobre 100,00: 21,00» names the base too: trust base × rate
    if vat_rate is None and vat_value is not None and base and amount(base[1]) and float(amount(base[1])) > 0:
        vat_rate = round(float(vat_value) / float(amount(base[1])), 2)
    tax_ids, after, before = [], {}, {}
    lines = [line.strip() for line in text.splitlines()]
    for index, line in enumerate(lines):
        for found in _TAX_ID.finditer(line.upper()):
            tax_id = found[1] or found[2]
            if tax_id not in tax_ids:
                tax_ids.append(tax_id)
                # The party's name usually follows its tax id (the customer block comes after the issuer's).
                after[tax_id] = next((n for n in lines[index + 1: index + 4] if _looks_like_name(n)), None)
                # A company's own block usually ends with its tax id: its name is the first line of that block.
                block = [n for n in lines[max(0, index - 6): index] if _looks_like_name(n)]
                legal = next((n for n in block if _LEGAL.search(n)), None)
                before[tax_id] = legal or (block[0] if block else None)
    webs = [w.lower() for w in re.findall(r"(?:https?://)?(?:www\.)?([a-z0-9-]{3,40})\.(?:es|com|net|org|eu|io|co)\b", text, re.I)
            if w.lower() not in ("google", "paypal", "apple", "facebook", "twitter", "instagram", "linkedin")]
    return {"v": VERSION, "web": webs[0] if webs else None, "taxIds": tax_ids[:4], "after": {t: after.get(t) for t in tax_ids[:4]}, "before": {t: before.get(t) for t in tax_ids[:4]}, "base": amount(base[1]) if base else None, "vatRate": vat_rate, "vat": vat_value,
            "withholdingRate": rate(irpf), "withholding": amount(irpf[2]) if irpf else None, "number": number[1] if number else None}
