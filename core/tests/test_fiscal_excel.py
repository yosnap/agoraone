import io
from datetime import date
from pathlib import Path

import openpyxl
from fastapi.testclient import TestClient

from agora_core import fiscal_excel, qonto
from agora_core.app import SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

SECRET, OWNER = "a" * 64, "b" * 64
INCOME = [{"date": "2026-10-03", "number": "F-1", "client": "Cliente", "taxId": "B12345678", "concept": "Curso", "base": 100, "vatRate": 0.21,
           "withholdingRate": 0.15, "withholding": 15, "total": 106, "currency": "EUR"}]
EXPENSES = [{"issuedOn": "2026-11-13", "supplier": "Proveedor", "taxId": None, "base": None, "vat": None, "total": "12.50", "currency": "EUR"},
            {"issuedOn": "2026-12-01", "supplier": "Hosting", "taxId": "EU123", "base": "10.00", "vat": "0.00", "total": "10.00", "currency": "USD"}]


def test_el_excel_tiene_el_formato_del_gestor():
    book = openpyxl.load_workbook(io.BytesIO(fiscal_excel.build(2026, 4, "Titular", INCOME, EXPENSES, ["Una nota."])))
    assert book.sheetnames == ["Resumen", "Ingresos", "Gastos"]
    ingresos, gastos, resumen = book["Ingresos"], book["Gastos"], book["Resumen"]
    assert ingresos["A1"].value.startswith("REGISTRO DE FACTURAS EMITIDAS — 4º TRIMESTRE 2026 (octubre–diciembre)")
    assert [c.value for c in ingresos[4]][:3] == ["Mes", "Fecha", "Nº factura"] and ingresos["A4"].fill.fgColor.rgb == "FF1F4E78"
    assert (ingresos["A5"].value, ingresos["B5"].value, ingresos["H5"].value, ingresos["I5"].value) == ("Octubre", "03/10/2026", 0.21, "=ROUND(G5*H5,2)")
    assert ingresos["L5"].value == "=G5+I5-K5" and ingresos["G6"].value == "=SUM(G5:G5)"
    assert all(ingresos[f"{c}5"].data_type == "f" for c in "IKL"), "IRPF y total de Ingresos son fórmulas, no texto"
    assert gastos["E5"].value == "—" and gastos["K6"].value == "USD"
    assert gastos["J7"].value == '=SUMIFS(J$5:J$6,$K$5:$K$6,"EUR")' and gastos["F8"].value == "TOTAL USD"
    assert resumen["A6"].value == "Octubre" and resumen["B22"].value == "=B20-B21" and resumen["A26"].value == "· Una nota."
    assert resumen["B13"].value.startswith("=SUMIFS(Gastos!G$5:G$6,Gastos!$A$5:$A$6,$A13")


def test_se_guarda_sin_sobrescribir(tmp_path):
    root = tmp_path.resolve()
    first = fiscal_excel.write(root, "Mi Actividad", 2026, 4, b"uno")
    second = fiscal_excel.write(root, "Mi Actividad", 2026, 4, b"dos")
    assert first == "Registro-4T-2026-Mi-Actividad.xlsx" and second.endswith("(2).xlsx") and (root / first).read_bytes() == b"uno"
    assert fiscal_excel.quarter_range(2026, 4) == (date(2026, 10, 1), date(2026, 12, 31))


class Answer:
    def __init__(self, status, body):
        self.status_code, self.body = status, body

    def json(self):
        return self.body


def test_facturas_emitidas_de_qonto_solo_lectura():
    calls = []

    def http(url, headers, params):
        calls.append((url, headers["Authorization"], params))
        if url.endswith("/credit_notes"):
            return Answer(200, {"credit_notes": [], "meta": {"next_page": None}})
        return Answer(200, {"client_invoices": [
            {"status": "paid", "issue_date": "2026-10-03", "number": "F-1", "client": {"name": "Cliente", "tax_identification_number": "B1"},
             "items": [{"title": "Curso", "vat_rate": "0.21"}], "total_amount": {"value": "121.00", "currency": "EUR"}, "vat_amount": {"value": "21.00"}},
            {"status": "draft", "issue_date": "2026-10-04", "number": "B"},
            {"status": "unpaid", "issue_date": "2026-09-30", "number": "Viejo"},
        ], "meta": {"next_page": None}})
    rows, notes = qonto.issued_invoices("org:clave", date(2026, 10, 1), date(2026, 12, 31), http=http)
    assert [r["number"] for r in rows] == ["F-1"] and rows[0]["base"] == 100.0 and rows[0]["vatRate"] == 0.21 and notes == []
    assert all(url.startswith(qonto.API) for url, _, _ in calls)
    import pytest
    with pytest.raises(qonto.QontoError, match="no acepta la clave"):
        qonto.check("org:mala", http=lambda u, h, p: Answer(401, {}))


class MemorySecrets:
    def __init__(self):
        self.values = {}

    def get(self, account):
        return self.values.get(account)

    def put(self, account, value):
        if value is None:
            self.values.pop(account, None)
        else:
            self.values[account] = value


def test_rutas_de_qonto_y_del_excel(tmp_path, monkeypatch):
    home = tmp_path / "home"
    work = home / "Trabajo" / "Actividad"
    work.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home)
    secrets = MemorySecrets()
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=secrets), base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        saved = client.put("/fiscal/qonto", json={"login": "mi-org", "secret": "clave-secreta-123"}, headers=headers).json()
        assert saved == {"login": "mi-org", "hasKey": True} and "clave-secreta-123" not in str(saved)
        assert secrets.values[qonto.SECRET_ACCOUNT] == "clave-secreta-123"
        monkeypatch.setattr(qonto, "issued_invoices", lambda auth, start, end, http=None: (INCOME, []))
        folder = client.post("/fiscal/folders", json={"name": "Actividad", "kind": "autonomo", "path": str(work)}, headers=headers).json()["folders"][0]
        view = client.get(f"/fiscal/folders/{folder['id']}/quarter?year=2026&quarter=4", headers=headers).json()
        assert view["income"] == INCOME and view["expenses"] == [] and view["incomeProblem"] is None
        made = client.post(f"/fiscal/folders/{folder['id']}/excel", json={"year": 2026, "quarter": 4}, headers=headers).json()
        assert made["path"] == "Registro-4T-2026-Actividad.xlsx" and (work / made["path"]).exists()


def test_forma_real_de_qonto_varios_tipos_irpf_y_rectificativas():
    invoice = {"status": "paid", "issue_date": "2026-11-02", "number": "F-9", "client": {"name": "C"}, "currency": "EUR",
               "withholding_tax": {"rate": "0.15", "amount": "15.00"},
               "items": [{"title": "Curso", "vat_rate": "0.21", "subtotal": {"value": "80.00"}, "total_vat": {"value": "16.80"}},
                         {"title": "Libro", "vat_rate": "0.04", "subtotal": {"value": "20.00"}, "total_vat": {"value": "0.80"}}],
               "total_amount": {"value": "102.60", "currency": "EUR"}, "vat_amount": {"value": "17.60"}}
    credit = {"status": "paid", "issue_date": "2026-11-20", "number": "R-1", "client": {"name": "C"},
              "items": [{"title": "Abono", "vat_rate": "0.21", "subtotal": {"value": "10.00"}, "total_vat": {"value": "2.10"}}]}
    broken = {"status": "paid", "issue_date": "2026-11-21", "items": "esto no es una lista"}

    def http(url, headers, params):
        assert params["sort_by"] == "created_at:asc" and "filter[created_at_to]" in params
        key = "credit_notes" if url.endswith("/credit_notes") else "client_invoices"
        return Answer(200, {key: [credit] if key == "credit_notes" else [invoice, broken], "meta": {"next_page": None}})
    rows, notes = qonto.issued_invoices("org:clave", date(2026, 10, 1), date(2026, 12, 31), http=http)
    by_rate = {(r["number"], r["vatRate"]): r for r in rows}
    assert by_rate[("F-9", 0.21)]["base"] == 80.0 and by_rate[("F-9", 0.04)]["base"] == 20.0
    assert by_rate[("F-9", 0.21)]["withholdingRate"] == 0.15
    assert by_rate[("R-1", 0.21)]["base"] == -10.0, "la rectificativa resta"
    assert any("no se pudieron leer" in n for n in notes)


def test_paginas_sin_fin_avisan():
    import pytest
    def http(url, headers, params):
        return Answer(200, {"client_invoices": [], "credit_notes": [], "meta": {"next_page": params["page"] + 1}})
    with pytest.raises(qonto.QontoError, match="demasiadas"):
        qonto.issued_invoices("org:clave", date(2026, 10, 1), date(2026, 12, 31), http=http)


def test_texto_de_terceros_nunca_es_formula():
    evil = [{**EXPENSES[0], "supplier": '=HYPERLINK("http://x","clic")', "notes": "@SUM(A1)\x0b"}]
    income = [{**INCOME[0], "client": "+cmd|' /C calc'!A0"}]
    book = openpyxl.load_workbook(io.BytesIO(fiscal_excel.build(2026, 4, "=Titular", income, evil, [])))
    assert book["Gastos"]["D5"].data_type == "s" and book["Gastos"]["D5"].value.startswith("=HYPERLINK")
    assert book["Gastos"]["L5"].value == "@SUM(A1)" and book["Ingresos"]["D5"].data_type == "s"
    assert book["Resumen"]["A2"].data_type == "s"


def test_cambio_a_euros_del_bce(tmp_path):
    from agora_core import exchange
    from agora_core.db import connect, migrate
    connection = connect(tmp_path / "a.db")
    migrate(connection)
    calls = []

    def http(url, params):
        calls.append(url)
        return Answer(200, {"date": "2026-09-12", "rates": {"EUR": 0.9}})
    rows = [{"issuedOn": "2026-09-13", "total": "11.95", "currency": "USD"}, {"issuedOn": "2026-09-13", "total": "5.00", "currency": "EUR"}]
    assert exchange.to_eur(connection, rows, "issuedOn", http=http) == []
    assert rows[0]["totalEur"] == 10.76 and rows[0]["rate"] == {"eur": 0.9, "day": "2026-09-12"} and "totalEur" not in rows[1]
    exchange.to_eur(connection, [{"issuedOn": "2026-09-13", "total": "1", "currency": "USD"}], "issuedOn", http=http)
    assert len(calls) == 1, "cada cambio se pide una vez"
    offline = [{"issuedOn": "2026-09-14", "total": "1", "currency": "GBP"}]
    assert exchange.to_eur(connection, offline, "issuedOn", http=lambda u, p: (_ for _ in ()).throw(__import__("httpx").ConnectError("x")))
    book = openpyxl.load_workbook(io.BytesIO(fiscal_excel.build(2026, 3, "T", [], rows, [])))
    assert book["Gastos"]["M4"].value == "Total EUR (cambio BCE)" and book["Gastos"]["M5"].value == 10.76 and book["Gastos"]["M6"].value == 5.0
    assert "Cambio BCE del 2026-09-12" in book["Gastos"]["L5"].value and book["Resumen"]["D18"].value.startswith("=SUMIFS(Gastos!M")


def test_pdf_de_una_factura_de_qonto():
    import pytest
    calls = []

    def http(url, headers, params):
        calls.append(url)
        return Answer(200, {"attachment": {"url": "https://s3.example/f.pdf"}})

    class File:
        status_code, content = 200, b"%PDF-1.4 factura"
    assert qonto.invoice_pdf("org:clave", {"attachmentId": "a1"}, http=http, download=lambda u: File()) == b"%PDF-1.4 factura"
    assert calls[0].endswith("/attachments/a1")
    with pytest.raises(qonto.QontoError):
        qonto.invoice_pdf("org:clave", {"pdfUrl": "http://inseguro/f.pdf"})
