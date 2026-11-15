"""The brain's side: areas from the top-level folders (with the index note's first sentence or, without one,
its biggest subfolders) and what changed today and yesterday; discreet mode shows only normal notes."""

from datetime import UTC, datetime

from agora_core import brain_home
from agora_core.db import DB_NAME, connect, migrate


def _note(c, ref, title, folder, level="normal", modified="2026-11-15T09:00:00Z", text=None):
    item = c.execute("INSERT INTO item (class, source, ref, title, folder, confidentiality, created_at, updated_at, modified_at) VALUES ('note', 'v', ?, ?, ?, ?, ?, ?, ?)",
                     (ref, title, folder, level, modified, modified, modified)).lastrowid
    if text:
        c.execute("INSERT INTO chunk (item_id, ord, text) VALUES (?, 0, ?)", (item, text))


def test_areas_y_ultimamente(tmp_path):
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    _note(c, "a", "Clientes", "Clientes", text="---\ntipo: índice\n---\n# Clientes\n\nTodo lo de cada cliente: alcance, presupuestos y contactos. Más texto.")
    _note(c, "b", "Acme", "Clientes/Acme")
    _note(c, "c", "Beta", "Clientes/Beta", modified="2026-11-14T10:00:00Z")
    _note(c, "d", "Salud", "Casa/Salud", level="private")
    _note(c, "e", "Viejo", "Casa/Obra", modified="2026-11-01T10:00:00Z")
    found = {a["name"]: a for a in brain_home.areas(c, discreet=False)}
    assert found["Clientes"] == {"name": "Clientes", "notes": 3, "subfolders": 2, "changed": "2026-11-15T09:00:00Z",
                                 "description": "Todo lo de cada cliente: alcance, presupuestos y contactos.", "written": True}
    assert found["Casa"]["description"] == "Incluye Obra y Salud" and not found["Casa"]["written"]
    assert [a["name"] for a in brain_home.areas(c, discreet=True)] == ["Clientes", "Casa"] and \
        {a["name"]: a["notes"] for a in brain_home.areas(c, discreet=True)}["Casa"] == 1, "en modo discreto, nada privado"
    now = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
    seen = brain_home.lately(c, discreet=False, now=now)
    assert [e["text"] for e in seen["today"]] == ["Clientes", "Acme", "Salud"] and [e["text"] for e in seen["yesterday"]] == ["Beta"]
    assert "Salud" not in [e["text"] for e in brain_home.lately(c, discreet=True, now=now)["today"]]
    c.close()
