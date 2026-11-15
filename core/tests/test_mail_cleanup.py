"""Tidying the mailbox: only the approved messages of the inbox move, to the trash or archive the server names;
nothing moves when the mailbox was renumbered or the server cannot move safely; never marked as read."""

import pytest

from agora_core import mail, mail_cleanup
from agora_core.db import DB_NAME, connect, migrate


class Server:
    def __init__(self, validity=7, capabilities=("IMAP4REV1", "MOVE")):
        self.validity, self.capabilities, self.calls, self.untagged_responses = validity, capabilities, [], {}

    def login(self, user, password):
        return "OK", []

    def select(self, box):
        self.calls.append(("select", box))
        self.untagged_responses = {"UIDVALIDITY": [str(self.validity).encode()]}
        return "OK", [b"3"]

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren \\Trash) "/" "Papelera"', b'(\\HasNoChildren \\Archive) "/" "Archivo"']

    def uid(self, command, *args):
        self.calls.append((command, *args))
        return "OK", []

    def logout(self):
        pass


@pytest.fixture
def db(tmp_path):
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    account = mail.create_account(c, {"provider": "other", "name": "Trabajo", "address": "yo@empresa.es", "username": "yo@empresa.es", "imapHost": "imap.empresa.es", "imapPort": 993})
    for uid, sender, subject in ((11, "ofertas@tienda.com", "Rebajas"), (12, "ofertas@tienda.com", "Más rebajas"), (13, "ana@cliente.com", "Presupuesto")):
        c.execute("INSERT INTO mail_message (account_id, folder, uidvalidity, uid, from_address, subject, sent_at, bytes, received_at) VALUES (?, 'INBOX', 7, ?, ?, ?, '2026-11-01T10:00:00Z', 10, 'x')",
                  (account, uid, sender, subject))
    c.commit()
    yield c
    c.close()


def test_mover_solo_lo_aprobado(db):
    found = mail_cleanup.candidates(db, sender="tienda.com")
    assert [m["subject"] for m in found] == ["Rebajas", "Más rebajas"] or [m["subject"] for m in found] == ["Más rebajas", "Rebajas"]
    with pytest.raises(mail_cleanup.CleanupError):
        mail_cleanup.candidates(db)
    server = Server()
    result = mail_cleanup.move(db, [found[0]["id"]], "trash", lambda account: "secreto", opener=lambda host, port: server)
    assert result == {"moved": 1, "problems": []}
    assert server.calls[0] == ("select", "INBOX") and server.calls[1][0] == "MOVE" and server.calls[1][2] == '"Papelera"'
    assert not any("Seen" in str(call) for call in server.calls), "nunca se marca como leído"
    assert len(mail_cleanup.candidates(db, sender="tienda.com")) == 1, "el movido ya no se vuelve a ofrecer"


def test_no_se_toca_nada_si_no_es_seguro(db):
    ids = [m["id"] for m in mail_cleanup.candidates(db, sender="cliente.com")]
    renumbered = Server(validity=8)
    assert mail_cleanup.move(db, ids, "archive", lambda a: "s", opener=lambda h, p: renumbered)["moved"] == 0
    assert not any(c[0] in ("MOVE", "COPY") for c in renumbered.calls)
    old = Server(capabilities=("IMAP4REV1",))
    result = mail_cleanup.move(db, ids, "archive", lambda a: "s", opener=lambda h, p: old)
    assert result["moved"] == 0 and "no permite mover" in result["problems"][0]
    with_uidplus = Server(capabilities=("IMAP4REV1", "UIDPLUS"))
    assert mail_cleanup.move(db, ids, "archive", lambda a: "s", opener=lambda h, p: with_uidplus)["moved"] == 1
    assert [c[0] for c in with_uidplus.calls[1:]] == ["COPY", "STORE", "EXPUNGE"] and with_uidplus.calls[3][1] == "13", "solo ese correo"
