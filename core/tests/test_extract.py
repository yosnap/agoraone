"""The PDF/DOCX extractor: real text out, and every limit refused (fabricated documents only)."""

import io
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from agora_core.extract import Refused, extract


def pdf_fixture(text: str = "Clave PDF: FARO-842", pages: int = 1) -> bytes:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 20 100 Td ({escaped}) Tj ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{' '.join(['3 0 R'] * pages)}] /Count {pages} >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(stream.encode())} >>\nstream\n{stream}\nendstream",
    ]
    pdf = "%PDF-1.4\n"
    offsets = []
    for index, body in enumerate(objects):
        offsets.append(len(pdf.encode()))
        pdf += f"{index + 1} 0 obj\n{body}\nendobj\n"
    xref = len(pdf.encode())
    rows = "".join(f"{offset:010d} 00000 n \n" for offset in offsets)
    pdf += f"xref\n0 6\n0000000000 65535 f \n{rows}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return pdf.encode()


def docx_fixture(text: str = "Clave DOCX: LUNA-913", oversized: bool = False) -> bytes:
    escaped = text.replace("&", "&amp;").replace("<", "&lt;")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        )
        archive.writestr(
            "word/document.xml",
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body><w:p><w:r><w:t>{escaped}</w:t></w:r></w:p></w:body></w:document>",
        )
        if oversized:
            archive.writestr("word/padding.bin", bytes(17 * 1024 * 1024))
    return buffer.getvalue()


def test_extrae_pdf_y_docx_reales_como_texto():
    assert "FARO-842" in extract("pdf", pdf_fixture())
    text = extract("docx", docx_fixture("Español: áéíóú, <script>texto</script> LUNA-913"))
    assert "áéíóú" in text and "<script>texto</script>" in text


@pytest.mark.parametrize(
    ("kind", "data"),
    [
        ("pdf", b"Texto normal"),
        ("docx", b"PKbad"),
        ("pdf", pdf_fixture("")),
        ("docx", docx_fixture("")),
        ("docx", docx_fixture("a" * 24577)),
        ("docx", docx_fixture("test", oversized=True)),
        ("pdf", pdf_fixture("texto", 101)),
        ("pdf", bytes(5 * 1024 * 1024 + 1)),
        ("pdf", b""),
    ],
)
def test_rechaza_danados_vacios_grandes_y_expansion_zip(kind, data):
    with pytest.raises((Refused, Exception)):
        extract(kind, data)


def test_como_proceso_solo_responde_json_o_falla_sin_salida():
    root = Path(__file__).resolve().parents[1]
    run = lambda kind, data: subprocess.run(  # noqa: E731
        [sys.executable, "-E", "-s", "-B", "-m", "agora_core.extract", kind], input=data, capture_output=True, cwd=root, timeout=30
    )
    ok = run("pdf", pdf_fixture())
    assert ok.returncode == 0 and b'"content"' in ok.stdout
    bad = run("docx", b"PKbad")
    assert bad.returncode == 1 and bad.stdout == b""
    assert run("exe", pdf_fixture()).returncode == 1
