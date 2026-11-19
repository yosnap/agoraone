"""The vault's review reads the index and changes nothing: loose notes, orphans, repeated titles, nearly empty
notes, lonely folders and notes with hidden credentials (titles only)."""

from agora_core import vault_review
from agora_core.db import DB_NAME, connect, migrate


def _note(c, ref, title, folder, text):
    item = c.execute("INSERT INTO item (class, source, ref, title, folder, created_at, updated_at, modified_at) VALUES ('note', 'v', ?, ?, ?, 'x', 'x', 'x')",
                     (ref, title, folder)).lastrowid
    c.execute("INSERT INTO chunk (item_id, ord, text) VALUES (?, 0, ?)", (item, text))
    return item


def test_revision_del_vault(tmp_path):
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    a = _note(c, "a.md", "Acme", "Clientes", "Ficha de Acme con todo lo que hace falta saber del cliente y sus proyectos activos.")
    _note(c, "b.md", "Acme", "Viejo", "Otra nota llamada igual, con texto suficiente para no contar como vacía, de verdad.")
    _note(c, "c.md", "Suelta", "", "corta")
    _note(c, "d.md", "Accesos", "Casa/Servicios", "Router de casa\n[credencial omitida]\nmás texto para que no sea una nota casi vacía ni mucho menos.")
    c.execute("INSERT INTO note_link (item_id, target) VALUES (?, 'Suelta')", (a,))
    found = vault_review.review(c, discreet=False)
    assert found["notes"] == 4 and found["rootCount"] == 1 and found["root"][0]["title"] == "Suelta"
    assert [d["title"] for d in found["duplicates"]] == ["Acme"]
    assert found["tinyCount"] == 1 and found["secretCount"] == 1 and found["secrets"][0] == {"key": "v/d.md", "title": "Accesos", "folder": "Casa/Servicios"}
    assert "Suelta" not in [o["title"] for o in found["orphans"]], "la enlaza otra nota"
    assert set(found["lonelyFolders"]) == {"Clientes", "Viejo", "Casa/Servicios"}
    c.close()
