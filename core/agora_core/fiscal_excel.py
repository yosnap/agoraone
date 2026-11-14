"""The quarterly register for the accountant, in the user's own format (three sheets with formulas):
Resumen, Ingresos (issued invoices) and Gastos (received invoices). Written into the fiscal folder under
a new name, never over another file."""

import io
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill

from .fiscal import FiscalError, _free, inside

MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]
ORDINAL = {1: "1er", 2: "2º", 3: "3er", 4: "4º"}
MONEY = "#,##0.00;\\-#,##0.00;\\-"
HEAD_FILL = PatternFill("solid", fgColor="FF1F4E78")
HEAD_FONT = Font(bold=True, color="FFFFFFFF")


def quarter_range(year: int, quarter: int) -> tuple[date, date]:
    start = date(year, 3 * quarter - 2, 1)
    end = date(year + (quarter == 4), 1 if quarter == 4 else 3 * quarter + 1, 1)
    return start, date.fromordinal(end.toordinal() - 1)


def _month(day: str) -> str:
    return MONTHS[int(day[5:7]) - 1]


def _dmy(day: str) -> str:
    return f"{day[8:10]}/{day[5:7]}/{day[:4]}"


def _number(value) -> float | None:
    try:
        return round(float(value), 2) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


TEXT_COLUMNS = {"A", "B", "C", "D", "E", "F", "K", "L"}


def _literal(sheet, row: int, columns=TEXT_COLUMNS) -> None:
    """Text from mail, PDFs or Qonto is always text: a name starting with «=» never becomes a formula, and
    control characters that Excel refuses are dropped."""
    for cell in sheet[row]:
        if cell.column_letter in columns and isinstance(cell.value, str):
            cell.value = ILLEGAL_CHARACTERS_RE.sub("", cell.value)
            cell.data_type = "s"


def _clean(values: list) -> list:
    return [ILLEGAL_CHARACTERS_RE.sub("", v) if isinstance(v, str) else v for v in values]


def _header(sheet, row: int, titles: list[str]) -> None:
    for column, title in enumerate(titles, 1):
        cell = sheet.cell(row=row, column=column, value=title)
        cell.font, cell.fill = HEAD_FONT, HEAD_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)


def _title(sheet, text: str, holder: str) -> None:
    sheet["A1"] = text
    sheet["A1"].font = Font(bold=True, size=14)
    sheet["A2"] = ILLEGAL_CHARACTERS_RE.sub("", holder or "")
    sheet["A2"].data_type = "s"


def build(year: int, quarter: int, holder: str, income: list[dict], expenses: list[dict], notes: list[str]) -> bytes:
    """The workbook as bytes. `income`: rows from Qonto; `expenses`: invoices filed in the folder."""
    months = MONTHS[3 * quarter - 3: 3 * quarter]
    span = f"{ORDINAL[quarter]} TRIMESTRE {year} ({months[0].lower()}–{months[-1].lower()})"
    book = Workbook()

    summary = book.active
    summary.title = "Resumen"
    ingresos = book.create_sheet("Ingresos")
    gastos = book.create_sheet("Gastos")

    # Ingresos
    _title(ingresos, f"REGISTRO DE FACTURAS EMITIDAS — {span}", holder)
    _header(ingresos, 4, ["Mes", "Fecha", "Nº factura", "Cliente", "NIF cliente", "Concepto", "Base imponible", "% IVA",
                          "IVA repercutido", "% IRPF", "IRPF retenido", "Total factura"])
    first = 5
    for n, row in enumerate(income):
        r = first + n
        ingresos.append(_clean([_month(row["date"]), _dmy(row["date"]), row.get("number"), row.get("client"), row.get("taxId"), row.get("concept"),
                         _number(row.get("base")), row.get("vatRate") or 0, f"=ROUND(G{r}*H{r},2)", row.get("withholdingRate") or 0,
                         f"=ROUND(G{r}*J{r},2)", f"=G{r}+I{r}-K{r}"]))
        _literal(ingresos, r)
    last_in = max(first, first + len(income) - 1)
    total_in = last_in + 1
    ingresos.cell(row=total_in, column=1, value="TOTAL").font = Font(bold=True)
    for column in "GIKL":
        ingresos[f"{column}{total_in}"] = f"=SUM({column}{first}:{column}{last_in})"
        ingresos[f"{column}{total_in}"].font = Font(bold=True)

    # Gastos
    _title(gastos, f"REGISTRO DE FACTURAS RECIBIDAS — {span}", holder)
    _header(gastos, 4, ["Mes", "Fecha", "Nº factura / recibo", "Proveedor", "NIF proveedor", "Concepto", "Base imponible", "% IVA",
                        "Cuota IVA", "Total", "Moneda", "Notas", "Total EUR (cambio BCE)"])
    for row in expenses:
        base, vat = _number(row.get("base")), _number(row.get("vat"))
        rate = round(vat / base, 2) if base and vat is not None else None
        gastos.append(_clean([_month(row["issuedOn"]), _dmy(row["issuedOn"]), row.get("number") or "", row.get("supplier"), row.get("taxId") or "—",
                       row.get("concept") or "", base, rate, vat, _number(row.get("total")), row.get("currency") or "EUR",
                       " ".join(filter(None, [row.get("notes") or "", f"Cambio BCE del {row['rate']['day']}: {row['rate']['eur']:.4f}" if row.get("rate") else ""])),
                       _number(row.get("totalEur")) if row.get("currency", "EUR") != "EUR" else _number(row.get("total"))]))
        _literal(gastos, gastos.max_row)
    last_out = max(first, first + len(expenses) - 1)
    for offset, currency in enumerate(("EUR", "USD"), 1):
        r = last_out + offset
        gastos.cell(row=r, column=6, value=f"TOTAL {currency}").font = Font(bold=True)
        for column in "GIJ":
            gastos[f"{column}{r}"] = f'=SUMIFS({column}${first}:{column}${last_out},$K${first}:$K${last_out},"{currency}")'
            gastos[f"{column}{r}"].font = Font(bold=True)

    # Resumen
    _title(summary, f"RESUMEN {span}", holder)
    summary["A4"] = "INGRESOS (facturas emitidas)"
    summary["A4"].font = Font(bold=True)
    _header(summary, 5, ["Mes", "Base imponible", "IVA repercutido", "IRPF retenido", "Total facturado"])
    for i, month in enumerate(months):
        r = 6 + i
        summary[f"A{r}"] = month
        for column, source in zip("BCDE", "GIKL"):
            summary[f"{column}{r}"] = f"=SUMIFS(Ingresos!{source}${first}:{source}${last_in},Ingresos!$A${first}:$A${last_in},$A{r})"
    summary["A9"] = f"TOTAL {quarter}T"
    for column in "BCDE":
        summary[f"{column}9"] = f"=SUM({column}6:{column}8)"
    summary["A11"] = "GASTOS (facturas recibidas) — en euros"
    summary["A11"].font = Font(bold=True)
    _header(summary, 12, ["Mes", "Base imponible", "IVA soportado", "Total"])
    for i, month in enumerate(months):
        r = 13 + i
        summary[f"A{r}"] = month
        for column, source in zip("BCD", "GIJ"):
            summary[f"{column}{r}"] = (f"=SUMIFS(Gastos!{source}${first}:{source}${last_out},Gastos!$A${first}:$A${last_out},$A{r},"
                                       f'Gastos!$K${first}:$K${last_out},"EUR")')
    summary["A16"] = f"TOTAL {quarter}T (EUR)"
    for column in "BCD":
        summary[f"{column}16"] = f"=SUM({column}13:{column}15)"
    summary["A17"] = "Gastos en USD (aparte)"
    for column, source in zip("BCD", "GIJ"):
        summary[f"{column}17"] = f'=SUMIFS(Gastos!{source}${first}:{source}${last_out},Gastos!$K${first}:$K${last_out},"USD")'
    summary["A18"] = "Gastos en otras monedas, en euros (cambio BCE)"
    summary["D18"] = f'=SUMIFS(Gastos!M${first}:M${last_out},Gastos!$K${first}:$K${last_out},"<>EUR")'
    summary["A19"] = "CIFRAS CLAVE DEL TRIMESTRE"
    summary["A19"].font = Font(bold=True)
    for r, (label, formula) in enumerate([
        ("IVA repercutido (ventas)", "=C9"), ("IVA soportado deducible (compras EUR con IVA español)", "=C16"),
        ("Diferencia de IVA (a ingresar en modelo 303)", "=B20-B21"), ("Retenciones IRPF soportadas en ventas (a cuenta del IRPF)", "=D9"),
        ("Rendimiento neto aprox. (base ingresos − base gastos EUR)", "=B9-B16"),
    ], 20):
        summary[f"A{r}"], summary[f"B{r}"] = label, formula
    for n, note in enumerate(notes[:20]):
        summary[f"A{26 + n}"] = ILLEGAL_CHARACTERS_RE.sub("", f"· {note}")
        summary[f"A{26 + n}"].data_type = "s"

    # Formats, as in the user's own register
    for sheet, money_columns in ((summary, "BCDE"), (ingresos, "GIKL"), (gastos, "GIJM")):
        for row in sheet.iter_rows(min_row=5):
            for cell in row:
                if cell.column_letter in money_columns:
                    cell.number_format = MONEY
    for sheet, column in ((ingresos, "H"), (ingresos, "J"), (gastos, "H")):
        for row in sheet.iter_rows(min_row=5, min_col=ord(column) - 64, max_col=ord(column) - 64):
            row[0].number_format = "0%"
    summary.column_dimensions["A"].width = 58
    for column in "BCDE":
        summary.column_dimensions[column].width = 16
    for sheet in (ingresos, gastos):
        for column, width in zip("ABCDEFGHIJKLM", (11, 11, 21, 32, 13, 48, 13, 7, 11, 11, 8, 50, 14)):
            sheet.column_dimensions[column].width = width
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def write(root: Path, folder_name: str, year: int, quarter: int, data: bytes) -> str:
    """Saves it at the folder's root as Registro-NT-AAAA-<carpeta>.xlsx, with a suffix if that name is taken."""
    safe = "".join(c for c in folder_name if c.isalnum() or c in " -_").strip().replace(" ", "-") or "carpeta"
    target = _free(inside(root, f"Registro-{quarter}T-{year}-{safe}.xlsx"))
    try:
        with open(target, "xb") as handle:
            handle.write(data)
    except OSError as error:
        raise FiscalError("No se pudo escribir el Excel en la carpeta fiscal.") from error
    return str(target.relative_to(root))
