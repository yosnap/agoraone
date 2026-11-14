from agora_core import cli
from agora_core.backup import create_backup, list_backups
from agora_core.db import DB_NAME, connect, migrate
from agora_core.keystore import MemoryStore, fingerprint, recovery_code, recovery_pending


def setup(tmp_path):
    folder = tmp_path / "data"
    connection = connect(folder / DB_NAME)
    migrate(connection)
    connection.close()
    return folder


def test_clave_de_recuperacion_se_muestra_y_queda_su_huella(tmp_path, capsys):
    folder, store = setup(tmp_path), MemoryStore()
    assert cli.main(["recovery-key"], store, folder) == 0
    assert recovery_code(store.key) in capsys.readouterr().out
    assert (folder / "recovery-key-shown").read_text().strip() == fingerprint(store.key)
    assert not recovery_pending(store, folder)
    assert cli.main(["recovery-key"], store, folder) == 1, "una vez basta"
    assert recovery_code(store.key) not in capsys.readouterr().out
    assert cli.main(["recovery-key", "--again"], store, folder) == 0


def test_aviso_si_la_clave_del_llavero_no_es_la_mostrada(tmp_path, capsys):
    folder, store = setup(tmp_path), MemoryStore()
    cli.main(["recovery-key"], store, folder)
    store.key = bytes(32)  # otra clave distinta de la que se mostró
    assert recovery_pending(store, folder)
    cli.main(["list"], store, folder)
    assert "aún no has guardado" in capsys.readouterr().out


def test_restaurar_con_recuperacion_guarda_la_clave_en_un_llavero_vacio(tmp_path, monkeypatch, capsys):
    folder, original = setup(tmp_path), MemoryStore()
    made = create_backup(folder, original)
    code = recovery_code(original.key)
    fresh = MemoryStore()  # otro Mac
    monkeypatch.setattr(cli, "port_free", lambda *_: True)
    monkeypatch.setattr(cli.getpass, "getpass", lambda _prompt: code)
    assert cli.main(["restore", str(made.path), "--recovery"], fresh, folder) == 0
    assert fresh.key == original.key
    assert not recovery_pending(fresh, folder)
    assert cli.main(["backup"], fresh, folder) == 0
    assert len(list_backups(folder)) == 2


def test_no_restaura_con_el_nucleo_en_marcha(tmp_path, monkeypatch):
    folder, store = setup(tmp_path), MemoryStore()
    made = create_backup(folder, store)
    monkeypatch.setattr(cli, "port_free", lambda *_: False)
    assert cli.main(["restore", str(made.path)], store, folder) == 3
