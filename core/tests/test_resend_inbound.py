"""Mail received through Resend, read with its API (no IMAP): each email once, its original downloaded without
the API key, kept like any other mail, and a key that cannot read explained. Resend is a stand-in."""

import json

import httpx
import pytest

from agora_core import mail, resend_inbound
from agora_core.db import DB_NAME, connect, migrate

RAW = (b"From: Ana <ana@cliente.es>\r\nTo: hola@midominio.com\r\nSubject: Presupuesto\r\nMessage-ID: <a1@cliente.es>\r\n"
       b"Date: Sun, 16 Nov 2026 10:00:00 +0100\r\n\r\nHola, necesito el presupuesto.\r\n")


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(resend_inbound, "PAUSE", 0)
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def resend(emails, status=200, seen=None, to="hola@midominio.com", raw=RAW, download=200):
    def handler(request: httpx.Request):
        seen.append((request.url.host, request.url.path, request.headers.get("authorization"))) if seen is not None else None
        if request.url.host == "files.resend.test":
            return httpx.Response(download, content=raw)
        if status != 200:
            return httpx.Response(status, json={"message": "API key is invalid" if status == 400 else "no"})
        if request.url.path == "/emails/receiving":
            return httpx.Response(200, json={"object": "list", "has_more": False, "data": [{"id": e, "created_at": "2026-11-16 09:00:00.000000+00", "to": [to if not e.startswith("x") else "otra@otrodominio.com"]} for e in emails]})
        return httpx.Response(200, json={"id": request.url.path.rsplit("/", 1)[-1], "raw": {"download_url": "https://files.resend.test/raw.eml"}})
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_lee_lo_recibido_una_vez_y_sin_dar_la_clave_al_enlace(db):
    account_id = mail.create_account(db, {"provider": "resend", "address": "hola@midominio.com"})
    account = db.execute("SELECT * FROM mail_account WHERE id = ?", (account_id,)).fetchone()
    assert account["inbound"] == 1, "Resend lee lo recibido por defecto"
    seen = []
    assert resend_inbound.sync(db, account, "re_full", mail._store, mail.MAX_MESSAGE, 50, client=resend(["e2", "e1"], seen=seen)) == 2
    rows = db.execute("SELECT folder, uid, subject, from_address FROM mail_message WHERE account_id = ? ORDER BY uid", (account_id,)).fetchall()
    assert [tuple(r) for r in rows] == [("RESEND", 1, "Presupuesto", "ana@cliente.es")] * 1 + [("RESEND", 2, "Presupuesto", "ana@cliente.es")]
    assert all(auth is None for host, _, auth in seen if host == "files.resend.test"), "la clave solo va a api.resend.com"
    assert all(auth == "Bearer re_full" for host, _, auth in seen if host == "api.resend.com")
    assert [p for h, p, _ in seen if h == "api.resend.com"][1] == "/emails/receiving/e1", "del más antiguo al más nuevo"
    assert resend_inbound.sync(db, account, "re_full", mail._store, mail.MAX_MESSAGE, 50, client=resend(["e3", "e2", "e1"])) == 1, "lo ya leído no se repite"
    assert resend_inbound.fetch_raw(db, account_id, 1, "re_full", mail.MAX_MESSAGE, client=resend([])) == RAW


def test_una_clave_de_solo_envio_se_explica(db, monkeypatch):
    account_id = mail.create_account(db, {"provider": "resend", "address": "hola@midominio.com"})
    account = db.execute("SELECT * FROM mail_account WHERE id = ?", (account_id,)).fetchone()
    with pytest.raises(resend_inbound.InboundError, match="Full access") as caught:
        resend_inbound.sync(db, account, "re_send", mail._store, mail.MAX_MESSAGE, 50, client=resend(["e1"], status=401))
    assert caught.value.status == "auth"
    refusing = resend(["e1"], status=403)
    monkeypatch.setattr(resend_inbound.httpx, "Client", lambda: refusing)
    assert mail.sync_account(db, account_id, "re_send") == {"status": "auth", "added": 0}
    row = db.execute("SELECT inbound, status, last_error FROM mail_account WHERE id = ?", (account_id,)).fetchone()
    assert row["inbound"] == 0 and row["status"] == "pending" and "desmarcado" in row["last_error"], "una clave de envío no pone la cuenta en rojo"
    assert mail.sync_account(db, account_id, "re_send") == {"status": "send", "added": 0}, "sin recibir, no se lee"
    box = mail.create_account(db, {"provider": "other", "address": "c@d.com", "imapHost": "imap.d.com"})
    with pytest.raises(mail.MailError):
        mail.update_account(db, box, {"inbound": True})


def test_una_clave_invalida_se_dice(db):
    account_id = mail.create_account(db, {"provider": "resend", "address": "hola@midominio.com"})
    account = db.execute("SELECT * FROM mail_account WHERE id = ?", (account_id,)).fetchone()
    with pytest.raises(resend_inbound.InboundError, match="no es válida") as caught:
        resend_inbound.sync(db, account, "re_mala", mail._store, mail.MAX_MESSAGE, 50, client=resend(["e1"], status=400))
    assert caught.value.status == "auth"


def test_solo_lo_de_su_direccion_y_nada_vacio(db, monkeypatch):
    a = mail.create_account(db, {"provider": "resend", "address": "hola@midominio.com"})
    b = mail.create_account(db, {"provider": "resend", "address": "privado@midominio.com", "confidentiality": "private"})
    row = lambda i: db.execute("SELECT * FROM mail_account WHERE id = ?", (i,)).fetchone()  # noqa: E731
    assert resend_inbound.sync(db, row(a), "k", mail._store, mail.MAX_MESSAGE, 50, client=resend(["e1", "x2"])) == 1, "lo de otros dominios no entra"
    assert resend_inbound.sync(db, row(b), "k", mail._store, mail.MAX_MESSAGE, 50, client=resend(["e1"], to="privado@midominio.com")) == 1
    assert db.execute("SELECT count(*) FROM mail_message WHERE account_id = ?", (a,)).fetchone()[0] == 1
    with pytest.raises(resend_inbound.InboundError, match="volverá a intentar"):
        resend_inbound.sync(db, row(a), "k", mail._store, mail.MAX_MESSAGE, 50, client=resend(["e5", "e1"], download=503))
    assert db.execute("SELECT count(*) FROM resend_message WHERE account_id = ?", (a,)).fetchone()[0] == 1, "un fallo al descargar no deja un correo vacío"
    big = RAW + b"x" * 200
    monkeypatch.setattr(mail, "MAX_MESSAGE", len(RAW) + 10)
    assert resend_inbound.sync(db, row(a), "k", mail._store, mail.MAX_MESSAGE, 50, client=resend(["e6", "e5", "e1"], raw=big)) == 2
    cut = db.execute("SELECT truncated, body FROM mail_message WHERE account_id = ? ORDER BY uid DESC LIMIT 1", (a,)).fetchone()
    assert cut["truncated"] == 1 and cut["body"] is None, "un original recortado no pasa por completo"
