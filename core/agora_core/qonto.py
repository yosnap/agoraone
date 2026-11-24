"""Qonto, read-only: the organisation's issued invoices for the quarterly register.

It signs in with the organisation's API key (its login, which is not secret, and the secret key, kept in
the Keychain). Only GET requests are ever made; AgoraOne never issues, changes or pays anything in Qonto.
Amounts may come as {"value": "12.50", "currency": "EUR"} or as cents, so both are read."""

import json
import sqlite3
from datetime import date, timedelta

import httpx

from . import tls

API = "https://thirdparty.qonto.com/v2"
LOGIN_SETTING = "qonto.login"
SECRET_ACCOUNT = "qonto-secret-key"
TIMEOUT = 20
MAX_PAGES = 20


class QontoError(RuntimeError):
    pass


def login(connection: sqlite3.Connection) -> str | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (LOGIN_SETTING,)).fetchone()
    return json.loads(row["value"]) if row else None


def clean_secret(value: str) -> str:
    value = value.strip()
    if any(c.isspace() for c in value):
        raise QontoError("La clave secreta no puede llevar espacios ni saltos de línea.")
    return value


def save_login(connection: sqlite3.Connection, value: str | None) -> None:
    if value is None:
        connection.execute("DELETE FROM setting WHERE key = ?", (LOGIN_SETTING,))
        return
    value = value.strip()
    if not 2 <= len(value) <= 120 or any(c.isspace() for c in value):
        raise QontoError("El identificador de Qonto no es válido.")
    connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                       (LOGIN_SETTING, json.dumps(value)))


def _get(path: str, auth: str, params: dict | None = None, http=None) -> dict:
    get = http or (lambda url, headers, params: httpx.get(url, headers=headers, params=params, timeout=TIMEOUT,
                                                         trust_env=False, verify=tls.client_context()))
    try:
        response = get(f"{API}{path}", {"Authorization": auth, "Accept": "application/json"}, params or {})
    except httpx.HTTPError as error:
        raise QontoError("No se pudo hablar con Qonto; revisa la conexión.") from error
    if response.status_code in (401, 403):
        raise QontoError("Qonto no acepta la clave: revisa el identificador y la clave secreta (Qonto › Ajustes › Integraciones › API).")
    if response.status_code != 200:
        raise QontoError(f"Qonto respondió {response.status_code}.")
    try:
        return response.json()
    except ValueError as error:
        raise QontoError("Qonto respondió algo que no se entiende.") from error


def check(auth: str, http=None) -> dict:
    """Signs in and says which organisation and accounts it sees (names only, never balances)."""
    data = _get("/organization", auth, http=http).get("organization", {})
    return {"name": data.get("legal_name") or data.get("name") or data.get("slug"), "accounts": len(data.get("bank_accounts", []))}


def _money(value) -> float | None:
    if isinstance(value, dict):
        value = value.get("value")
    try:
        return round(float(value), 2) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _rate(value) -> float | None:
    """Qonto gives rates as decimals ("0.21"); a percentage ("21") is turned into one."""
    number = _money(value)
    if number is None:
        return None
    return round(number / 100, 4) if number > 1 else number


def _rows(item: dict, sign: int) -> list[dict]:
    """One register row per VAT rate of an invoice (what the VAT return needs), from its lines."""
    issued = (item.get("issue_date") or "")[:10]
    client = item.get("client") or {}
    name = client.get("name") or " ".join(filter(None, [client.get("first_name"), client.get("last_name")]))
    withholding = item.get("withholding_tax") if isinstance(item.get("withholding_tax"), dict) else {}
    currency = item.get("currency") or (item.get("total_amount") or {}).get("currency") or "EUR"
    common = {"date": issued, "number": item.get("number") or "", "client": name or "", "currency": currency,
              "qontoId": item.get("id"), "attachmentId": item.get("attachment_id"), "pdfUrl": item.get("invoice_url") or item.get("pdf_url"),
              "taxId": client.get("tax_identification_number") or client.get("vat_number") or "",
              "withholdingRate": _rate(withholding.get("rate")) or 0.0}
    groups: dict[float, dict] = {}
    for line in item.get("items") or []:
        rate = _rate(line.get("vat_rate")) or 0.0
        base = _money(line.get("subtotal"))
        if base is None and _money(line.get("total_amount")) is not None:
            base = _money(line.get("total_amount")) - (_money(line.get("total_vat")) or 0)
        if base is None:
            continue  # a line without amounts: the invoice's own totals are used below
        group = groups.setdefault(rate, {"base": 0.0, "vat": 0.0, "titles": []})
        group["base"] += base
        group["vat"] += _money(line.get("total_vat")) or round(base * rate, 2)
        if line.get("title"):
            group["titles"].append(str(line["title"]))
    if not groups:  # no lines: the base is what is left of the total once VAT is taken out and withholding put back
        total, vat = _money(item.get("total_amount")) or 0, _money(item.get("vat_amount")) or 0
        base = total - vat + (_money(withholding.get("amount")) or 0)
        groups[_rate(round(vat / base, 4)) if base else 0.0] = {"base": base, "vat": vat, "titles": []}
    return [{**common, "concept": "; ".join(g["titles"])[:200], "base": round(sign * g["base"], 2), "vatRate": rate,
             "vat": round(sign * g["vat"], 2)} for rate, g in groups.items()]


def _list(path: str, key: str, auth: str, start: date, end: date, sign: int, http) -> tuple[list[dict], int]:
    """Documents issued in [start, end] (searched with a margin on their creation date, which may be earlier
    than the issue date or a day off in UTC), oldest first; returns the rows and how many could not be read."""
    rows, skipped, page = [], 0, 1
    params = {"filter[created_at_from]": f"{(start - timedelta(days=120)).isoformat()}T00:00:00Z",
              "filter[created_at_to]": f"{(end + timedelta(days=31)).isoformat()}T23:59:59Z",
              "sort_by": "created_at:asc", "per_page": 100, "exclude_imported": "false"}
    while page:
        if page > MAX_PAGES:
            raise QontoError("Hay demasiadas facturas en Qonto para este periodo: no se ha podido leer todo.")
        data = _get(path, auth, {**params, "page": page}, http=http)
        for item in data.get(key, []):
            try:
                issued = (item.get("issue_date") or "")[:10]
                if item.get("status") in ("draft", "canceled", "cancelled") or not (start.isoformat() <= issued <= end.isoformat()):
                    continue
                rows += _rows(item, sign)
            except (TypeError, ValueError, AttributeError, KeyError):
                skipped += 1
        page = (data.get("meta") or {}).get("next_page")
    return rows, skipped


def issued_invoices(auth: str, start: date, end: date, http=None) -> tuple[list[dict], list[str]]:
    """Issued invoices (one row per VAT rate) and credit notes as negative rows, with notes about anything
    that could not be read or does not add up in euros."""
    invoices, skipped = _list("/client_invoices", "client_invoices", auth, start, end, 1, http)
    notes = []
    try:
        credit, skipped_credit = _list("/credit_notes", "credit_notes", auth, start, end, -1, http)
    except QontoError as error:
        credit, skipped_credit = [], 0
        notes.append(f"No se pudieron leer las facturas rectificativas de Qonto: {error}")
    rows = sorted(invoices + credit, key=lambda r: (r["date"], r["number"]))
    if skipped + skipped_credit:
        notes.append(f"{skipped + skipped_credit} facturas de Qonto no se pudieron leer: revísalas en Qonto.")
    if foreign := sum(1 for r in rows if r["currency"] != "EUR"):
        notes.append(f"{foreign} facturas emitidas en otra moneda: comprueba su cambio a euros.")
    return rows, notes


def invoice_pdf(auth: str, row: dict, http=None, download=None) -> bytes:
    """The PDF of an issued invoice: through its attachment (a signed link Qonto gives) or its own link."""
    url = None
    if row.get("attachmentId"):
        data = _get(f"/attachments/{row['attachmentId']}", auth, http=http).get("attachment") or {}
        url = data.get("url") or data.get("file_url")
    url = url or row.get("pdfUrl")
    if not url or not str(url).startswith("https://"):
        raise QontoError("Qonto no da el PDF de esta factura.")
    try:
        data = download(url) if download else _fetch(url)
    except httpx.HTTPError as error:
        raise QontoError("No se pudo descargar el PDF de Qonto.") from error
    if not data.startswith(b"%PDF-") or len(data) > MAX_PDF:
        raise QontoError("Lo que da Qonto no es un PDF.")
    return data


MAX_PDF = 15 * 1024 * 1024


def _fetch(url: str) -> bytes:
    """The file, read in pieces and cut off past MAX_PDF; at most three redirects, and only to https."""
    with httpx.Client(verify=tls.client_context(), timeout=TIMEOUT, follow_redirects=False, trust_env=False) as client:
        for _ in range(4):
            with client.stream("GET", url) as response:
                if response.is_redirect:
                    url = str(response.url.join(response.headers.get("location", "")))
                    if not url.startswith("https://"):
                        return b""
                    continue
                if response.status_code != 200:
                    return b""
                data = bytearray()
                for chunk in response.iter_bytes():
                    data += chunk
                    if len(data) > MAX_PDF:
                        return b""
                return bytes(data)
    return b""
