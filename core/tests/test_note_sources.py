"""A mail's attachments and shared documents for its note: only those of that mail, a shared document only from a
service that hands it without a sign-in, never a web page, every redirect checked, and nothing kept in the core."""

import email.message
import json
import re

import httpx
import pytest

from agora_core import mail, note_sources, orca_launch, repo_notes
from agora_core.app import SECRET_HEADER

from test_orca_launch import add_mail
from test_repo_notes import SECRET, client, repo  # noqa: F401 - fixtures

BODY = ("Os paso el plano https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing y la hoja "
        "https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNm/edit, el vídeo en https://we.tl/t-abc123 y "
        "la web https://acme.com/precios.")


def test_lista_solo_documentos_compartidos_y_cuales_se_descargan():
    found = note_sources.links(BODY)
    assert [(f["service"], f["downloadable"]) for f in found] == [("Google Drive", True), ("Google Drive", True), ("WeTransfer", False)]
    assert note_sources.direct(found[1]["url"]) == "https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNm/export?format=xlsx"
    assert note_sources.direct("https://www.dropbox.com/scl/fi/abc/plano.pdf?rlkey=x&dl=0").endswith("rlkey=x&dl=1")


def test_nombres_seguros():
    assert note_sources.safe_name("../../.ssh/id‮rsa.pdf") == "idrsa.pdf"
    assert note_sources.safe_name(".oculto") == "oculto"
    assert note_sources.safe_name("a:b|c.PDF") == "a b c.pdf"
    assert note_sources.safe_name("Informe final. Revisado") == "Informe final. Revisado"
    assert not note_sources.savable("x.html") and not note_sources.savable("sin extension") and note_sources.savable("factura.XSIG")


def test_la_lista_de_tipos_es_la_misma_que_la_del_vault():
    from pathlib import Path
    rust = (Path(__file__).parents[2] / "desktop/server/src/vault/write.rs").read_text()
    listed = rust.split("const FILE_TYPES: &[&str] = &[", 1)[1].split("];", 1)[0]
    assert set(re.findall(r'"([a-z0-9]+)"', listed)) == note_sources.FILE_TYPES


def fake(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)


def test_descarga_sigue_redirecciones_comprobadas_y_rechaza_paginas(monkeypatch):
    seen = []
    monkeypatch.setattr(note_sources, "_public", lambda host: seen.append(host) or host != "10.0.0.1")
    def handler(request):
        if request.url.host == "drive.usercontent.google.com":
            return httpx.Response(302, headers={"location": "https://doc-0s.googleusercontent.com/x"})
        return httpx.Response(200, content=b"%PDF-1", headers={"content-type": "application/pdf", "content-disposition": "attachment; filename*=UTF-8''Plano%20final.pdf"})
    assert note_sources.download("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", fake(handler)) == ("Plano final.pdf", b"%PDF-1")
    assert seen == ["drive.usercontent.google.com", "doc-0s.googleusercontent.com"]
    elsewhere = fake(lambda request: httpx.Response(302, headers={"location": "https://ejemplo.com/x"}))
    with pytest.raises(note_sources.SourceError, match="servicio"):
        note_sources.download("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", elsewhere)
    script = fake(lambda request: httpx.Response(200, content=b"x", headers={"content-type": "application/octet-stream", "content-disposition": "attachment; filename=x.sh"}))
    with pytest.raises(note_sources.SourceError, match="tipo"):
        note_sources.download("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", script)
    page = fake(lambda request: httpx.Response(200, content=b"<html>", headers={"content-type": "text/html"}))
    with pytest.raises(note_sources.SourceError, match="página"):
        note_sources.download("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", page)
    inside = fake(lambda request: httpx.Response(302, headers={"location": "https://doc.googleusercontent.com:8443/x"}))
    with pytest.raises(note_sources.SourceError, match="https pública"):
        note_sources.download("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", inside)
    with pytest.raises(note_sources.SourceError, match="navegador"):
        note_sources.download("https://we.tl/t-abc123")


def raw_with_attachment() -> bytes:
    message = email.message.EmailMessage()
    message["Subject"] = "Plano"
    message.set_content("Adjunto el plano")
    message.add_attachment(b"%PDF-plano", maintype="application", subtype="pdf", filename="Plano.pdf")
    return message.as_bytes()


def test_rutas_de_adjuntos_y_repositorio(client, repo, monkeypatch):  # noqa: F811
    test_client, connection = client
    headers = {SECRET_HEADER: SECRET}
    message = add_mail(connection, body=BODY)
    raw = raw_with_attachment()
    parts = [i for i, p in enumerate(__import__("email").message_from_bytes(raw).walk()) if p.get_filename()]
    connection.execute("UPDATE mail_message SET attachments = ? WHERE id = ?",
                       (json.dumps([{"name": "Plano.pdf", "type": "application/pdf", "bytes": 10, "part": parts[0]}]), message))
    connection.commit()
    monkeypatch.setattr(mail, "fetch_raw", lambda *args, **kwargs: raw)
    listed = test_client.get(f"/mail/inbox/{message}/sources", headers=headers).json()
    assert listed["attachments"][0]["name"] == "Plano.pdf" and len(listed["links"]) == 3
    got = test_client.post(f"/mail/inbox/{message}/file", json={"kind": "attachment", "part": parts[0]}, headers=headers)
    assert got.status_code == 200 and got.content == b"%PDF-plano" and got.headers["content-disposition"] == "attachment; filename*=UTF-8''Plano.pdf"
    assert test_client.post(f"/mail/inbox/{message}/file", json={"kind": "attachment", "part": 99}, headers=headers).status_code == 422
    assert test_client.post(f"/mail/inbox/{message}/file", json={"kind": "link", "url": "https://drive.google.com/file/d/OTRO1234567/view"},
                            headers=headers).status_code == 422
    body = {"client": "Acme", "project": "Web", "folder": "docs/notas", "prefix": "Menú", "name": "Menú - Plano.pdf", "inboxId": message, "kind": "attachment", "part": parts[0]}
    for bad in ("../x.pdf", "x.html"):
        assert test_client.post("/orca/repo-file", json={**body, "name": bad}, headers=headers).status_code == 422
    saved = test_client.post("/orca/repo-file", json=body, headers=headers)
    assert saved.status_code == 201 and (repo / "docs" / "notas" / "Menú - Plano.pdf").read_bytes() == b"%PDF-plano"
    assert test_client.post("/orca/repo-file", json=body, headers=headers).status_code == 422  # never over an existing file
