"""Accounts that only send (Resend or any SMTP relay): created without IMAP, never read, editable, and their
SMTP sign-in checked without sending anything. Servers are stand-ins."""

import smtplib

import pytest

from agora_core import mail, mail_send
from agora_core.db import DB_NAME, connect, migrate


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def test_resend_sin_imap_y_nunca_se_lee(db):
    account = mail.create_account(db, {"provider": "resend", "address": "Hola@MiDominio.com", "inbound": False})
    listed = mail.list_accounts(db, lambda i: True)[0]
    assert listed["kind"] == "send" and listed["provider"] == "resend" and listed["username"] == "resend"
    assert (listed["smtpHost"], listed["smtpPort"]) == ("smtp.resend.com", 465) and listed["address"] == "hola@midominio.com"
    opened = []
    assert mail.sync_account(db, account, "re_x", opener=lambda *a: opened.append(a)) == {"status": "send", "added": 0}
    assert opened == [], "una cuenta de solo envío no abre IMAP"
    with pytest.raises(mail.MailError, match="SMTP"):
        mail.create_account(db, {"provider": "smtp", "address": "a@b.com"})
    other = mail.create_account(db, {"provider": "smtp", "address": "a@b.com", "smtpHost": "smtp.sendgrid.net", "smtpPort": 587, "username": "apikey"})
    assert mail.list_accounts(db, lambda i: True)[0]["provider"] == "smtp" and other


def test_se_editan_usuario_servidor_y_puerto(db):
    account = mail.create_account(db, {"provider": "smtp", "address": "a@b.com", "smtpHost": "smtp.viejo.com"})
    mail.update_account(db, account, {"smtpHost": "smtp.nuevo.com", "smtpPort": 587, "username": "apikey"})
    row = db.execute("SELECT * FROM mail_account WHERE id = ?", (account,)).fetchone()
    assert (row["smtp_host"], row["smtp_port"], row["username"], row["imap_host"], row["status"]) == ("smtp.nuevo.com", 587, "apikey", "smtp.nuevo.com", "pending")
    with pytest.raises(mail.MailError):
        mail.update_account(db, account, {"smtpHost": None})
    with pytest.raises(mail.MailError):
        mail.update_account(db, account, {"smtpHost": "https://x.com"})
    box = mail.create_account(db, {"provider": "other", "address": "c@d.com", "imapHost": "imap.d.com"})
    mail.update_account(db, box, {"imapHost": "imap.nuevo.com", "imapPort": 143, "smtpHost": "smtp.d.com"})
    row = db.execute("SELECT imap_host, imap_port, smtp_host FROM mail_account WHERE id = ?", (box,)).fetchone()
    assert tuple(row) == ("imap.nuevo.com", 143, "smtp.d.com")


class Fake:
    def __init__(self, refuse=False):
        self.refuse, self.logged = refuse, None

    def login(self, user, password):
        if self.refuse:
            raise smtplib.SMTPAuthenticationError(535, b"no")
        self.logged = (user, password)

    def quit(self):
        pass


def test_probar_el_inicio_de_sesion_smtp_sin_enviar():
    fake = Fake()
    assert mail_send.check_login("smtp.resend.com", 465, "resend", "re_x", opener=lambda h, p: fake)[0] == "ok" and fake.logged == ("resend", "re_x")
    assert mail_send.check_login("smtp.resend.com", 465, "resend", "mala", opener=lambda h, p: Fake(refuse=True))[0] == "auth"
    def down(h, p):
        raise OSError("sin red")
    assert mail_send.check_login("smtp.resend.com", 465, "resend", "re_x", opener=down)[0] == "unreachable"
    assert mail_send.check_login("smtp.resend.com", 465, "resend", None)[0] == "auth"
