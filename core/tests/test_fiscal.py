from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agora_core import fiscal, fiscal_folder, invoice_extract, mail
from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect, migrate
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

PDF = b"%PDF-1.4\n% factura de prueba\n%%EOF\n"
SECRET, OWNER = "a" * 64, "b" * 64


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def test_la_carpeta_fiscal_nunca_es_la_personal_ni_icloud(tmp_path):
    home = tmp_path / "home"
    work = home / "Trabajo" / "Actividad"
    work.mkdir(parents=True)
    assert fiscal.check_folder(str(work), home=home) == work.resolve()
    for bad in (home, tmp_path, home / "no-existe"):
        with pytest.raises(fiscal.FiscalError):
            fiscal.check_folder(str(bad), home=home)


def test_rutas_dentro_de_la_carpeta(tmp_path):
    root = tmp_path / "fiscal"
    root.mkdir()
    (tmp_path / "fuera").mkdir()
    (root / "atajo").symlink_to(tmp_path / "fuera")
    assert fiscal.inside(root.resolve(), "Facturas Entrantes/2026/4T/a.pdf").name == "a.pdf"
    for bad in ("../fuera/a.pdf", "/etc/passwd", "atajo/a.pdf", "~/a.pdf"):
        with pytest.raises(fiscal.FiscalError):
            fiscal.inside(root.resolve(), bad)


def test_importes_y_destino():
    assert [fiscal.amount(v) for v in ("1.234,50", "1,234.50", "12,5 €", "30", 7.1, "nada")] == ["1234.50", "1234.50", "12.50", "30.00", "7.10", None]
    assert fiscal.destination("PayPal / Europe", "2026-11-13", "12.50") == "Facturas Entrantes/2026/4T/2026-11-13 PayPal Europe 12,50.pdf"


def folder_in(db, root, kind="autonomo", name="Autónomo"):
    folder_id = db.execute("INSERT INTO fiscal_folder (name, kind, path, created_at) VALUES (?, ?, ?, 'x')", (name, kind, str(root))).lastrowid
    return {"id": folder_id, "kind": kind}


def test_archivar_sin_sobrescribir(db, tmp_path):
    root = (tmp_path / "fiscal")
    root.mkdir()
    root = root.resolve()
    fields = {"supplier": "Proveedor", "issuedOn": "2026-02-03", "total": "10,00", "taxId": "b12345678"}
    folder = folder_in(db, root)
    first = fiscal.file_invoice(db, folder, root, PDF, fields, None, [])
    second = fiscal.file_invoice(db, folder, root, PDF + b"2\n%%EOF", fields, None, ["No aparece el NIF del proveedor."])
    assert first["path"] == "Facturas Entrantes/2026/1T/2026-02-03 Proveedor 10,00.pdf" and first["quarter"] == "2026-1T"
    assert second["path"].endswith("10,00 (2).pdf") and (root / first["path"]).read_bytes() == PDF
    listed = fiscal.invoices(db, "2026-1T")
    assert {i["taxId"] for i in listed} == {"B12345678"} and listed[0]["doubts"] == ["No aparece el NIF del proveedor."]
    with pytest.raises(fiscal.FiscalError):
        fiscal.file_invoice(db, folder, root, b"<html>no</html>", fields, None, [])
    personal = folder_in(db, (tmp_path / "personal"), "personal", "Personal")
    (tmp_path / "personal").mkdir()
    with pytest.raises(fiscal.FiscalError):
        fiscal.file_invoice(db, personal, (tmp_path / "personal").resolve(), b"\xff\xd8\xff foto", fields, None, [])
    photo = fiscal.file_invoice(db, personal, (tmp_path / "personal").resolve(), b"\xff\xd8\xff foto", fields, None, [], "compras")
    assert photo["path"] == "Compras/2026/2026-02-03 Proveedor 10,00.jpg"


def test_campos_de_la_factura_y_cotejo():
    text = "ACME SL  CIF: B12345678\nFecha de factura: 13/11/2026\nBase imponible 10,33 €\nIVA 21% 2,17 €\nTOTAL 12,50 €"
    found = invoice_extract.fields(text)
    assert found == {"taxId": "B12345678", "total": "12.50", "issuedOn": "2026-11-13", "dateAmbiguous": False, "currency": "EUR"}
    assert invoice_extract.doubts(found, {"amounts": ["12,50 €"]}) == []
    assert "no coincide" in invoice_extract.doubts(found, {"amounts": ["15,00 €"]})[0]
    english = invoice_extract.fields("Invoice date 2026-10-01\nVAT ID: IE6388047V\nAmount paid $20.00")
    assert english["taxId"] == "IE6388047V" and english["total"] == "20.00" and english["currency"] == "USD"
    assert any("USD" in d for d in invoice_extract.doubts(english, {}))


def test_enlaces_y_descargas_solo_publicas():
    body = "Hola. Descarga tu factura: https://pagos.example.com/invoice/123.pdf\nVisita https://example.com/blog"
    assert invoice_extract.links(body) == ["https://pagos.example.com/invoice/123.pdf"]
    for bad in ("http://example.com/f.pdf", "https://127.0.0.1/f.pdf", "https://localhost/f.pdf"):
        with pytest.raises(invoice_extract.ExtractError):
            invoice_extract.download(bad, http=lambda u: None)


def test_texto_del_pdf_falla_sin_romper():
    class Done:
        returncode, stdout = 1, b""
    assert invoice_extract.pdf_text(PDF, runner=lambda *a, **k: Done()) == ""


def test_plan_de_reordenacion_y_aplicarlo(tmp_path):
    root = (tmp_path / "fiscal")
    files = {
        "Facturas Entrantes/Julio2025/Apple/a.pdf": "2025/3T/Apple/a.pdf",
        "Facturas Entrantes/2026/Noviembre 2026/b.pdf": "2026/4T/b.pdf",
        "Facturas Entrantes/2026/Retrasados 2 trimestre/c.pdf": "2026/2T/c.pdf",
        "Facturas Salientes/1 trimestre/Febrero2025/d.pdf": "2025/1T/d.pdf",
        "Facturas Entrantes/3 trimestre/dudosa.pdf": None,
        "Facturas Entrantes/2026/4T/ya.pdf": "ok",
        "Impuestos/x.pdf": "ok",
    }
    for path in files:
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_bytes(path.encode())
    root = root.resolve()
    result = fiscal_folder.plan(root)
    assert {m["from"]: m["to"].split("/", 1)[1] for m in result["moves"]} == {p: t for p, t in files.items() if t and t != "ok"}
    assert result["undecided"] == ["Facturas Entrantes/3 trimestre/dudosa.pdf"]
    (root / "Facturas Entrantes/2025/3T/Apple").mkdir(parents=True)
    (root / "Facturas Entrantes/2025/3T/Apple/a.pdf").write_bytes(b"otro")  # the name is taken
    moves = {m["from"]: m for m in fiscal_folder.plan(root)["moves"]}
    done = fiscal_folder.apply(root, tmp_path / "copias", [moves["Facturas Entrantes/Julio2025/Apple/a.pdf"]])
    assert done["moved"][0]["to"] == "Facturas Entrantes/2025/3T/Apple/a (2).pdf"
    assert (root / "Facturas Entrantes/2025/3T/Apple/a.pdf").read_bytes() == b"otro", "nada se sobrescribe"
    assert (tmp_path / "copias" / done["backup"] / "Facturas Entrantes/Julio2025/Apple/a.pdf").exists(), "copia previa"
    with pytest.raises(fiscal.FiscalError):
        fiscal_folder.apply(root, tmp_path / "copias", [{"from": "Facturas Entrantes/2026/Noviembre 2026/b.pdf", "to": "Impuestos/b.pdf"}])


def test_rutas_fiscales(tmp_path, monkeypatch):
    home = tmp_path / "home"
    work = home / "Trabajo" / "Actividad"
    work.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home)
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=None)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        assert client.post("/fiscal/invoices/prepare", json={"messageId": 1}, headers=headers).status_code == 422
        assert client.post("/fiscal/folders", json={"name": "Casa", "kind": "personal", "path": str(home)}, headers=headers).status_code == 422
        added = client.post("/fiscal/folders", json={"name": "Autónomo", "kind": "autonomo", "path": str(work)}, headers=headers).json()["folders"]
        assert added[0]["path"] == str(work.resolve())
        (work / "Dentro").mkdir()
        assert client.post("/fiscal/folders", json={"name": "Otra", "kind": "empresa", "path": str(work / "Dentro")}, headers=headers).status_code == 422
        folder_id = added[0]["id"]
        connection = connect(tmp_path / "data" / DB_NAME)
        account = mail.create_account(connection, {"address": "yo@gmail.com", "provider": "gmail"})
        message = connection.execute(
            """INSERT INTO mail_message (account_id, folder, uidvalidity, uid, from_address, from_name, subject, body, sent_at, received_at)
               VALUES (?, 'INBOX', 1, 1, 'service@paypal.example', 'PayPal', 'Recibo', 'Tu factura: https://paypal.example/invoice/1', '2026-11-13T10:00:00Z', '2026-11-13T10:00:00Z')""",
            (account,)).lastrowid
        connection.close()
        prepared = client.post("/fiscal/invoices/prepare", json={"messageId": message}, headers=headers).json()
        assert prepared["source"] is None and prepared["links"] == [{"url": "https://paypal.example/invoice/1", "host": "paypal.example"}]
        assert prepared["destination"].startswith("Facturas Entrantes/2026/4T/2026-11-13 PayPal")
        fields = {"supplier": "PayPal", "issuedOn": "2026-11-13", "total": "12,50"}
        assert prepared["folderId"] == folder_id, "la única carpeta profesional se propone sola"
        other = client.post("/fiscal/invoices", json={"messageId": message, "folderId": folder_id, "source": {"kind": "link", "url": "https://malo.example/x.pdf"}, "fields": fields}, headers=headers)
        assert other.status_code == 422 and "no está en el correo" in other.json()["error"]
        assert client.get(f"/fiscal/folders/{folder_id}/plan", headers=headers).json() == {"moves": [], "undecided": [], "more": 0}


def _pdf(text: bytes) -> bytes:
    content = b"BT /F1 12 Tf 72 720 Td (" + text + b") Tj ET"
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for number, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + obj + b"\nendobj\n"
    start = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, start)


def test_texto_real_del_pdf_en_el_extractor_aislado():
    text = invoice_extract.pdf_text(_pdf(b"CIF B12345678 Fecha 13/11/2026 TOTAL 12,50 EUR"))
    assert invoice_extract.fields(text) == {"taxId": "B12345678", "total": "12.50", "issuedOn": "2026-11-13", "dateAmbiguous": False, "currency": "EUR"}



def test_carpetas_que_contienen_icloud_u_ocultas_no_valen(tmp_path):
    home = tmp_path / "home"
    icloud = home / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
    (icloud / "Trabajo").mkdir(parents=True)
    (home / ".ssh").mkdir()
    (home / "Library" / "Keychains").mkdir()
    assert fiscal.check_folder(str(icloud / "Trabajo"), home=home)
    for bad in (home / "Library" / "Mobile Documents", icloud, home / ".ssh", home / "Library" / "Keychains", "Trabajo"):
        with pytest.raises(fiscal.FiscalError):
            fiscal.check_folder(str(bad), home=home)


def test_fechas_imposibles_ambiguas_y_total_de_iva():
    assert invoice_extract.fields("Válida hasta 31/02/2026")["issuedOn"] is None
    found = invoice_extract.fields("Fecha 03/11/2026\nTotal 12,10 €\nTotal IVA 2,10 €")
    assert found["total"] == "12.10" and found["dateAmbiguous"]
    assert any("día/mes" in d for d in invoice_extract.doubts(found, {"amounts": ["12,10"]}))
    assert any("cotejar" in d for d in invoice_extract.doubts(found, {}))
    assert fiscal.amount("1.234") == "1234.00"


def test_nombres_de_carpeta_que_no_son_fechas():
    for folders in (["Proveedores mayoristas"], ["Julio Pérez"], ["Diciembre 2023 (pagadas en enero)"], ["Hosting 2048"]):
        year, quarter, _ = fiscal_folder._where(folders) if folders != ["Diciembre 2023 (pagadas en enero)"] else (None, None, [])
        assert year is None or quarter is None, folders
    with pytest.raises(fiscal_folder.Unclear):
        fiscal_folder._where(["Diciembre 2023 (pagadas en enero)"])
    assert fiscal_folder._where(["2024", "Amazon", "marzo"]) == (2024, 1, ["Amazon"])


def test_trimestre_en_minusculas_no_se_mueve_y_fallo_a_medias(tmp_path, monkeypatch):
    root = tmp_path / "fiscal"
    for path in ("Facturas Entrantes/2024/1t/a.pdf", "Facturas Entrantes/Mayo 2025/b.pdf", "Facturas Entrantes/Junio 2025/c.pdf"):
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_bytes(b"x")
    root = root.resolve()
    moves = fiscal_folder.plan(root)["moves"]
    assert [m["from"] for m in moves] == ["Facturas Entrantes/Junio 2025/c.pdf", "Facturas Entrantes/Mayo 2025/b.pdf"]
    real_copy, calls = fiscal_folder.shutil.copy2, []

    def copy_then_fail(source, target):  # the disk fills up on the second file
        calls.append(source)
        if len(calls) > 1:
            raise OSError("disco lleno")
        return real_copy(source, target)
    monkeypatch.setattr(fiscal_folder.shutil, "copy2", copy_then_fail)
    seen = []
    done = fiscal_folder.apply(root, tmp_path / "copias", moves, on_move=lambda a, b: seen.append((a, b)))
    assert [m["from"] for m in done["moved"]] == ["Facturas Entrantes/Junio 2025/c.pdf"] and done["error"]
    assert seen == [("Facturas Entrantes/Junio 2025/c.pdf", "Facturas Entrantes/2025/2T/c.pdf")], "el registro sigue a lo movido"


def test_la_misma_factura_no_se_archiva_dos_veces(db, tmp_path):
    root = (tmp_path / "fiscal")
    root.mkdir()
    fields = {"supplier": "Proveedor", "issuedOn": "2026-02-03", "total": "10"}
    folder = folder_in(db, root.resolve())
    fiscal.file_invoice(db, folder, root.resolve(), PDF, fields, None, [])
    with pytest.raises(fiscal.Duplicate):
        fiscal.file_invoice(db, folder, root.resolve(), PDF, fields, None, [])
