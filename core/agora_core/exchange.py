"""Converting foreign-currency invoices to euros with the European Central Bank's reference rate of the
invoice's date (on weekends and holidays, the last published one), as Spanish bookkeeping usually does.

Rates come from frankfurter.dev, a free public mirror of the ECB's data: only a date and a currency code are
sent. They are kept in the core's database, so each one is asked for once."""

import sqlite3
from decimal import ROUND_HALF_UP, Decimal

import httpx

API = "https://api.frankfurter.dev/v1"
TIMEOUT = 10


class ExchangeError(RuntimeError):
    pass


def eur_rate(connection: sqlite3.Connection, day: str, currency: str, http=None) -> tuple[float, str]:
    """(euros per unit, date of the rate used)."""
    currency = currency.upper()
    if currency == "EUR":
        return 1.0, day
    row = connection.execute("SELECT eur, rate_day FROM exchange_rate WHERE day = ? AND currency = ?", (day, currency)).fetchone()
    if row:
        return row["eur"], row["rate_day"]
    get = http or (lambda url, params: httpx.get(url, params=params, timeout=TIMEOUT, trust_env=False))
    try:
        response = get(f"{API}/{day}", {"from": currency, "to": "EUR"})
        data = response.json() if response.status_code == 200 else {}
    except (httpx.HTTPError, ValueError) as error:
        raise ExchangeError("No se pudo consultar el cambio del BCE (¿sin conexión?).") from error
    value = (data.get("rates") or {}).get("EUR")
    if not isinstance(value, (int, float)) or value <= 0:
        raise ExchangeError(f"El BCE no publica el cambio de {currency}.")
    connection.execute("INSERT OR REPLACE INTO exchange_rate (day, currency, eur, rate_day) VALUES (?, ?, ?, ?)",
                       (day, currency, float(value), data.get("date") or day))
    return float(value), data.get("date") or day


def to_eur(connection: sqlite3.Connection, rows: list[dict], day_key: str, http=None) -> list[str]:
    """Adds `totalEur` and `rate` to every row not in euros; returns notes about what could not be converted."""
    missing = 0
    for row in rows:
        currency = (row.get("currency") or "EUR").upper()
        if currency == "EUR" or row.get("total") in (None, "", "0"):
            continue
        try:
            rate, rate_day = eur_rate(connection, row[day_key], currency, http=http)
        except ExchangeError:
            missing += 1
            continue
        # Money rounds half up (10.755 → 10.76), not as binary floats do.
        row["totalEur"] = float((Decimal(str(row["total"])) * Decimal(str(rate))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        row["rate"] = {"eur": rate, "day": rate_day}
    return [f"{missing} facturas en otra moneda sin cambio a euros (sin conexión con el BCE): se convertirán al volver a cargar."] if missing else []
