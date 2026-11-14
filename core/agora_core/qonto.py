"""Qonto, read-only: the organisation's issued invoices for the quarterly register.

It signs in with the organisation's API key (its login, which is not secret, and the secret key, kept in
the Keychain). Only GET requests are ever made; AgoraOne never issues, changes or pays anything in Qonto.
Amounts may come as {"value": "12.50", "currency": "EUR"} or as cents, so both are read."""

import json
import sqlite3
from datetime import date

import httpx

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
    get = http or (lambda url, headers, params: httpx.get(url, headers=headers, params=params, timeout=TIMEOUT, trust_env=False))
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


def _cents(item: dict, *names: str) -> float | None:
    for name in names:
        if item.get(name) not in (None, ""):
            found = _money(item[name])
            if found is not None:
                return found
        if item.get(f"{name}_cents") not in (None, ""):
            return round(int(item[f"{name}_cents"]) / 100, 2)
    return None


def issued_invoices(auth: str, start: date, end: date, http=None) -> list[dict]:
    """Issued invoices with an issue date in [start, end], neither drafts nor cancelled, as register rows."""
    rows, page = [], 1
    while page and page <= MAX_PAGES:
        data = _get("/client_invoices", auth, {"filter[created_at_from]": f"{start.isoformat()}T00:00:00Z", "page": page, "per_page": 100}, http=http)
        for item in data.get("client_invoices", []):
            issued = (item.get("issue_date") or "")[:10]
            if item.get("status") in ("draft", "canceled", "cancelled") or not (start.isoformat() <= issued <= end.isoformat()):
                continue
            client = item.get("client") or {}
            items = item.get("items") or []
            total = _cents(item, "total_amount", "amount")
            vat = _cents(item, "vat_amount")
            base = _cents(item, "subtotal_amount", "total_amount_excluding_vat") or (round(total - vat, 2) if total is not None and vat is not None else None)
            rates = {str(i.get("vat_rate")) for i in items if i.get("vat_rate") not in (None, "")}
            withholding = _cents(item, "withholding_tax_amount")
            rows.append({
                "date": issued, "number": item.get("number") or item.get("invoice_number") or "",
                "client": client.get("name") or " ".join(filter(None, [client.get("first_name"), client.get("last_name")])) or "",
                "taxId": client.get("tax_identification_number") or client.get("vat_number") or "",
                "concept": "; ".join(str(i.get("title") or "") for i in items if i.get("title"))[:200],
                "base": base, "vatRate": float(next(iter(rates))) if len(rates) == 1 else None,
                "withholdingRate": _money(item.get("withholding_tax_rate")), "withholding": withholding,
                "total": total, "currency": (item.get("currency") or (item.get("total_amount") or {}).get("currency") or "EUR"),
            })
        meta = data.get("meta") or {}
        page = meta.get("next_page")
    return sorted(rows, key=lambda r: (r["date"], r["number"]))
