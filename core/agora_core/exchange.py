"""Converting foreign-currency invoices to euros with the European Central Bank's reference rate of the
invoice's date (on weekends and holidays, the last published one), as Spanish bookkeeping usually does.

Rates come from frankfurter.dev, a free public mirror of the ECB's data: only a date and a currency code are
sent. They are kept in the core's database, so each one is asked for once."""

import sqlite3
import time
from decimal import ROUND_HALF_UP, Decimal

import httpx

API = "https://api.frankfurter.dev/v1"
TIMEOUT = 4  # per request: with BUDGET, one load waits at most about BUDGET + TIMEOUT seconds
BUDGET = 5.0  # seconds of network per load: the rest wait for the next one
RETRY_AFTER = 600  # a failed (day, currency) is not asked again for ten minutes
_FAILED: dict[tuple[str, str], tuple[float, "ExchangeError"]] = {}


class ExchangeError(RuntimeError):
    pass


class UnknownCurrency(ExchangeError):
    """The ECB does not publish that currency: asking again will not help."""


def eur_rate(connection: sqlite3.Connection, day: str, currency: str, http=None) -> tuple[float, str]:
    """(euros per unit, date of the rate used)."""
    currency = currency.upper()
    if currency == "EUR":
        return 1.0, day
    row = connection.execute("SELECT eur, rate_day FROM exchange_rate WHERE day = ? AND currency = ?", (day, currency)).fetchone()
    if row:
        return row["eur"], row["rate_day"]
    failed = _FAILED.get((day, currency))
    if failed and (isinstance(failed[1], UnknownCurrency) or time.monotonic() - failed[0] < RETRY_AFTER):
        raise failed[1]
    try:
        value, data = _ask(http, day, currency)
    except ExchangeError as error:
        _FAILED[(day, currency)] = (time.monotonic(), error)
        raise
    _FAILED.pop((day, currency), None)
    connection.execute("INSERT OR REPLACE INTO exchange_rate (day, currency, eur, rate_day) VALUES (?, ?, ?, ?)",
                       (day, currency, float(value), data.get("date") or day))
    return float(value), data.get("date") or day


def _ask(http, day: str, currency: str) -> tuple[float, dict]:
    get = http or (lambda url, params: httpx.get(url, params=params, timeout=TIMEOUT, trust_env=False))
    try:
        response = get(f"{API}/{day}", {"from": currency, "to": "EUR"})
        data = response.json() if response.status_code == 200 else {}
    except (httpx.HTTPError, ValueError) as error:
        raise ExchangeError("No se pudo consultar el cambio del BCE (¿sin conexión?).") from error
    value = (data.get("rates") or {}).get("EUR")
    if response.status_code in (404, 422) or (response.status_code == 200 and not isinstance(value, (int, float))):
        raise UnknownCurrency(f"El BCE no publica el cambio de {currency}.")
    if not isinstance(value, (int, float)) or value <= 0:
        raise ExchangeError("No se pudo consultar el cambio del BCE (¿sin conexión?).")
    return value, data


def to_eur(connection: sqlite3.Connection, rows: list[dict], day_key: str, http=None) -> list[str]:
    """Adds `totalEur` and `rate` to every row not in euros; returns notes about what could not be converted.
    A failure is not asked again for a while, and one load spends at most BUDGET seconds on the network."""
    offline, unknown, started = 0, set(), time.monotonic()
    for row in rows:
        currency = (row.get("currency") or "EUR").upper()
        if currency == "EUR" or row.get("total") in (None, "", "0"):
            continue
        cached = connection.execute("SELECT 1 FROM exchange_rate WHERE day = ? AND currency = ?", (row[day_key], currency)).fetchone()
        if not cached and time.monotonic() - started > BUDGET:
            offline += 1
            continue
        try:
            rate, rate_day = eur_rate(connection, row[day_key], currency, http=http)
        except UnknownCurrency:
            unknown.add(currency)
            continue
        except ExchangeError:
            offline += 1
            continue
        # Money rounds half up (10.755 → 10.76), not as binary floats do.
        row["totalEur"] = float((Decimal(str(row["total"])) * Decimal(str(rate))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        row["rate"] = {"eur": rate, "day": rate_day}
    notes = [f"{offline} facturas en otra moneda sin cambio a euros (sin conexión con el BCE): se convertirán más tarde."] if offline else []
    if unknown:
        notes.append(f"El BCE no publica el cambio de {', '.join(sorted(unknown))}: conviértelas a euros a mano.")
    return notes


def income_to_eur(connection: sqlite3.Connection, rows: list[dict], http=None) -> list[str]:
    """Issued invoices in another currency go into the register in euros (base and total with the ECB rate of
    their date); the original amount stays in the concept. Returns the same notes as `to_eur`."""
    notes = to_eur(connection, rows, "date", http=http)
    for row in rows:
        foreign = (row.get("currency") or "EUR").upper() != "EUR"
        if foreign and not row.get("rate") and row.get("base") is not None and row.get("total") in (None, "", "0"):
            try:  # no total read: the base alone is converted (to_eur only looks at totals)
                rate, rate_day = eur_rate(connection, row["date"], row["currency"], http=http)
                row["rate"] = {"eur": rate, "day": rate_day}
            except ExchangeError:
                notes.append(f"Una factura emitida en {row['currency']} sin cambio a euros: su base no se ha convertido.")
        rate = row.get("rate")
        if not rate or row.get("base") is None:
            continue
        original = f"{row['currency']} {float(row['base']):.2f}"
        row["base"] = float((Decimal(str(row["base"])) * Decimal(str(rate["eur"]))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        row["total"] = row.get("totalEur")
        row["concept"] = f"{row.get('concept') or ''} (base {original}, cambio BCE del {rate['day']})".strip()
        row["currency"] = "EUR"
        row["foreign"] = original
    return notes
