import imaplib
import json
from email.message import EmailMessage

import pytest
from fastapi.testclient import TestClient

from agora_core import mail
from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect, migrate
from agora_core.keystore import MemoryStore
from agora_core.mail_parse import html_to_text, parse, tidy
from agora_core.settings import load_settings

SECRET = "a" * 64
OWNER = "b" * 64


def message(uid: int, subject: str = "Factura", html: bool = False, attachment: bool = False) -> bytes:
    msg = EmailMessage()
    msg["From"] = "Proveedor Uno <facturas@proveedor.example>"
    msg["To"] = "yo@example.com"
    msg["Subject"] = f"{subject} {uid}"
    msg["Date"] = "Fri, 13 Nov 2026 10:00:00 +0100"
    msg["Message-ID"] = f"<m{uid}@proveedor.example>"
    if html:
        msg.set_content("<html><head><style>p{}</style></head><body><p>Hola&nbsp;Paulo</p><script>alert(1)</script><p>Total: 12 €</p></body></html>", subtype="html")
    else:
        msg.set_content(f"Texto del mensaje {uid}.")
    if attachment:
        msg.add_attachment(b"%PDF-1.4 prueba", maintype="application", subtype="pdf", filename="factura-001.pdf")
    return msg.as_bytes()


class FakeImap:
    """Enough of imaplib.IMAP4 for the sync, and it fails any command that could change the mailbox."""

    def __init__(self, messages: dict[int, bytes], uidvalidity: int = 7, password: str = "clave-buena", sizes: bool = True, refuse: set[int] | None = None):
        self.messages, self.uidvalidity, self.password = messages, uidvalidity, password
        self.sizes, self.refuse = sizes, refuse or set()
        self.commands: list[str] = []
        self.readonly = None

    def login(self, user, password):
        password.encode("ascii")  # like imaplib, which sends arguments as ASCII
        if password != self.password:
            raise imaplib.IMAP4.error("AUTHENTICATIONFAILED")

    def select(self, folder, readonly=False):
        self.readonly = readonly
        return "OK", [str(len(self.messages)).encode()]

    def response(self, code):
        return code, [str(self.uidvalidity).encode()]

    def uid(self, command, *args):
        text = " ".join(str(a) for a in (command, *args) if a is not None)
        self.commands.append(text)
        upper = text.upper()
        assert not any(word in upper for word in ("STORE", "EXPUNGE", "COPY", "MOVE", "DELETE")), text
        assert "BODY[" not in upper or "BODY.PEEK[" in upper, text
        if command == "SEARCH":
            if args[1] == "UID":
                start = int(args[2].split(":")[0])
                found = [u for u in self.messages if u >= start] or [max(self.messages)]  # like servers, n:* returns the last one
            else:
                found = list(self.messages)
            return "OK", [" ".join(map(str, sorted(found))).encode()]
        if command == "FETCH":
            uids, spec = [int(u) for u in args[0].split(",")], args[1]
            data = []
            if "RFC822.SIZE" not in spec and uids[0] in self.refuse:
                return "NO", [b"no disponible ahora"]
            for uid in uids:
                if "RFC822.SIZE" in spec:
                    data.append(f"{uid} (UID {uid} RFC822.SIZE {len(self.messages[uid])})".encode() if self.sizes else f"{uid} (UID {uid})".encode())
                else:
                    data.append((f"{uid} (UID {uid} BODY[] {{{len(self.messages[uid])}}}".encode(), self.messages[uid]))
                    data.append(b")")
            return "OK", data
        raise AssertionError(text)

    def logout(self):
        pass


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def test_el_html_se_lee_como_texto_sin_scripts_ni_estilos():
    parsed = parse(message(1, html=True))
    assert parsed.body == "Hola Paulo\n\nTotal: 12 €"
    assert "alert" not in parsed.body and "p{}" not in parsed.body
    assert tidy(html_to_text("<p>a<b>b</p")) == "ab", "HTML mal cerrado se lee igual"


def test_cabeceras_fecha_y_adjuntos():
    parsed = parse(message(3, attachment=True))
    assert parsed.from_address == "facturas@proveedor.example" and parsed.from_name == "Proveedor Uno"
    assert parsed.subject == "Factura 3" and parsed.sent_at == "2026-11-13T09:00:00Z"
    assert parsed.attachments == [{"name": "factura-001.pdf", "type": "application/pdf", "bytes": 15, "part": 2}]
    assert parse(b"From: roto\r\nDate: no es una fecha\r\n\r\ncuerpo").sent_at is None


def test_sincroniza_solo_lo_nuevo_y_sin_tocar_el_buzon(db):
    account = mail.create_account(db, {"address": "Yo@Example.com", "provider": "gmail"})
    server = FakeImap({1: message(1), 2: message(2, attachment=True)})
    assert mail.sync_account(db, account, "clave-buena", lambda host, port: server) == {"status": "ok", "added": 2}
    assert server.readonly is True, "se abre con EXAMINE"
    assert any("SINCE" in c for c in server.commands)
    server.messages[3] = message(3)
    assert mail.sync_account(db, account, "clave-buena", lambda host, port: server)["added"] == 1
    assert mail.sync_account(db, account, "clave-buena", lambda host, port: server)["added"] == 0, "n:* devuelve el último, ya leído"
    rows = db.execute("SELECT uid, subject, attachments FROM mail_message ORDER BY uid").fetchall()
    assert [r["uid"] for r in rows] == [1, 2, 3]
    assert json.loads(rows[1]["attachments"])[0]["name"] == "factura-001.pdf"
    status = db.execute("SELECT status, last_error, imap_host, username FROM mail_account").fetchone()
    assert (status["status"], status["last_error"], status["imap_host"], status["username"]) == ("ok", None, "imap.gmail.com", "yo@example.com")


def test_si_el_servidor_renumera_se_vuelve_a_leer(db):
    account = mail.create_account(db, {"address": "yo@example.com", "provider": "icloud"})
    server = FakeImap({5: message(5)})
    mail.sync_account(db, account, "clave-buena", lambda h, p: server)
    server.uidvalidity, server.messages = 8, {1: message(1)}
    mail.sync_account(db, account, "clave-buena", lambda h, p: server)
    assert [r["uid"] for r in db.execute("SELECT uid FROM mail_message")] == [1]


def test_fallos_de_clave_y_de_red_quedan_en_la_cuenta_sin_la_contrasena(db):
    account = mail.create_account(db, {"address": "yo@example.com", "provider": "hostinger"})
    assert mail.sync_account(db, account, None)["status"] == "auth"
    assert mail.sync_account(db, account, "mala", lambda h, p: FakeImap({}))["status"] == "auth"
    error = db.execute("SELECT last_error FROM mail_account").fetchone()[0]
    assert "mala" not in error and "contraseña" in error

    def unreachable(host, port):
        raise OSError("sin red")
    assert mail.sync_account(db, account, "clave-buena", unreachable)["status"] == "unreachable"
    assert "imap.hostinger.com:993" in db.execute("SELECT last_error FROM mail_account").fetchone()[0]


def test_validacion_de_cuentas(db):
    with pytest.raises(mail.MailError):
        mail.create_account(db, {"address": "sin-arroba"})
    with pytest.raises(mail.MailError):
        mail.create_account(db, {"address": "yo@example.com", "provider": "other"})  # falta el servidor
    with pytest.raises(mail.MailError):
        mail.create_account(db, {"address": "yo@example.com", "provider": "other", "imapHost": "https://mail.example.com"})
    with pytest.raises(mail.MailError):
        mail.create_account(db, {"address": "yo@example.com", "provider": "gmail", "scopeId": 99})
    mail.create_account(db, {"address": "yo@example.com", "provider": "namecheap"})
    with pytest.raises(mail.MailError, match="ya está conectada"):
        mail.create_account(db, {"address": "YO@example.com", "provider": "namecheap"})


def test_un_correo_malformado_no_atasca_la_cuenta(db):
    account = mail.create_account(db, {"address": "yo@example.com", "provider": "gmail"})
    broken = b"From: a@b.example\r\nTo: g:;@x\r\nSubject: roto\r\nContent-Disposition: attachment; filename=\"a\x00b.pdf\"\r\n\r\ncuerpo"
    server = FakeImap({1: message(1), 2: broken, 3: message(3)})
    assert mail.sync_account(db, account, "clave-buena", lambda h, p: server) == {"status": "ok", "added": 3}
    assert db.execute("SELECT last_uid FROM mail_folder_state").fetchone()[0] == 3
    assert parse(broken).to_addresses == [] and parse(broken).subject == "roto"


def test_sin_tamano_se_pide_con_limite_y_un_fetch_rechazado_no_se_pierde(db):
    account = mail.create_account(db, {"address": "yo@example.com", "provider": "gmail"})
    server = FakeImap({1: message(1), 2: message(2)}, sizes=False, refuse={2})
    assert mail.sync_account(db, account, "clave-buena", lambda h, p: server)["status"] == "error"
    assert any(f"<0.{mail.MAX_MESSAGE}>" in c for c in server.commands), "sin tamaño, nunca más del límite"
    assert db.execute("SELECT last_uid FROM mail_folder_state").fetchone()[0] == 1, "el 2 se reintentará"
    server.refuse = set()
    assert mail.sync_account(db, account, "clave-buena", lambda h, p: server)["added"] == 1


def test_contrasena_con_letras_no_ascii_y_errores_inesperados(db):
    account = mail.create_account(db, {"address": "yo@example.com", "provider": "hostinger"})
    assert mail.sync_account(db, account, "contraseña", lambda h, p: FakeImap({}))["status"] == "auth"
    assert "letras" in db.execute("SELECT last_error FROM mail_account").fetchone()[0]

    class Broken(FakeImap):
        def select(self, folder, readonly=False):
            raise RuntimeError("inesperado")
    assert mail.sync_account(db, account, "clave-buena", lambda h, p: Broken({}))["status"] == "error"
    assert "RuntimeError" in db.execute("SELECT last_error FROM mail_account").fetchone()[0]


def test_cambios_todo_o_nada_y_sin_nulos_obligatorios(db):
    account = mail.create_account(db, {"address": "yo@example.com", "provider": "gmail", "label": "antes"})
    for change in ({"label": "nuevo", "username": None}, {"enabled": None}, {"imapPort": None}, {"label": "nuevo", "imapPort": 70000}):
        with pytest.raises(mail.MailError):
            mail.update_account(db, account, change)
    row = db.execute("SELECT label, enabled, imap_port FROM mail_account").fetchone()
    assert (row["label"], row["enabled"], row["imap_port"]) == ("antes", 1, 993)
    with pytest.raises(mail.MailError, match="Usuario"):
        mail.update_account(db, account, {"username": "yo\r\nA1 STORE 1 +FLAGS (\\Deleted)"})
    with pytest.raises(mail.MailError, match="Usuario"):
        mail.create_account(db, {"address": "otro@example.com", "provider": "gmail", "username": "con espacio"})


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


def test_rutas_de_cuentas_y_ambitos(tmp_path):
    secrets = MemorySecrets()
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        assert "gmail" in client.get("/mail/presets", headers=headers).json()["presets"]
        scopes = client.post("/scopes", json={"name": "CodeIA", "fiscal": True}, headers=headers).json()["scopes"]
        codeia = next(s for s in scopes if s["name"] == "CodeIA")
        assert codeia["slug"] == "codeia"
        created = client.post("/mail/accounts", json={"address": "yo@example.com", "provider": "gmail", "scopeId": codeia["id"],
                                                      "password": "clave-de-app"}, headers=headers)
        assert created.status_code == 201
        account = created.json()["accounts"][0]
        assert account["hasPassword"] and account["scopeName"] == "CodeIA" and "password" not in json.dumps(account).lower().replace("haspassword", "")
        assert secrets.get(f"mail:{account['id']}") == "clave-de-app"
        changed = client.put(f"/mail/accounts/{account['id']}", json={"password": None, "confidentiality": "local_only"}, headers=headers).json()
        assert not changed["accounts"][0]["hasPassword"] and changed["accounts"][0]["confidentiality"] == "local_only"
        synced = client.post(f"/mail/accounts/{account['id']}/sync", headers=headers).json()
        assert synced["result"]["status"] == "auth"
        assert client.delete(f"/mail/accounts/{account['id']}", headers=headers).json() == {"accounts": []}
        assert client.delete(f"/mail/accounts/{account['id']}", headers=headers).status_code == 404
        assert client.post("/mail/accounts", json={"address": "x@example.com", "provider": "other"}, headers=headers).status_code == 422
        assert client.post("/scopes", json={"name": "   "}, headers=headers).status_code == 422
