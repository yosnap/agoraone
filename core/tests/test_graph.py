import hashlib

import pytest
from fastapi.testclient import TestClient

from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache, embed_pending
from agora_core.graph import graph
from agora_core.index import Note, links, upsert_notes
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

from test_index import SECRET, SOURCE, note, ref

OTHER = "vault-" + "b" * 24


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


class TopicEmbedder:
    """One dimension per topic (the first word of the text): same topic, same vector; different, orthogonal."""

    model = "temas"

    def embed(self, texts):
        vectors = []
        for text in texts:
            vector = [0.0] * 32
            vector[int(hashlib.sha256(text.split()[0].encode()).hexdigest(), 16) % 32] = 1.0
            vectors.append(vector)
        return vectors


def test_enlaces_normalizados_y_fuera_de_codigo():
    text = "---\nrel: '[[Propiedad]]'\n---\n[[Carpeta/Nota Uno.md|alias]] y ![[Imagen]] y [[Uno#Sección]]\n```\n[[Código]]\n```\n[[ÁRBOL^bloque]]"
    assert links(text) == ["nota uno", "imagen", "uno", "árbol"]


def test_grafo_resuelve_enlaces_por_titulo_dentro_del_mismo_vault(db):
    upsert_notes(db, SOURCE, "Vault", [
        note(1, "Uno", "ver [[Dos]] y [[Inexistente]] y [[uno]]"),
        note(2, "Dos", "vuelve a [[Uno]]"),
        note(3, "Tres", "suelta"),
    ])
    upsert_notes(db, OTHER, "Otro", [note(4, "Dos", "homónima en otro vault")])
    result = graph(db, None, VectorCache(), discreet=False, near=False)
    assert result["total"] == 4 and not result["truncated"] and not result["semantic"]
    assert result["edges"] == [{"a": f"{SOURCE}/{ref(1)}", "b": f"{SOURCE}/{ref(2)}", "kind": "link"}], \
        "ida y vuelta es una sola arista; ni enlaces a sí misma, ni a notas que no existen, ni a otro vault"
    degree = {n["title"] + n["source"][-1]: n["degree"] for n in result["nodes"]}
    assert degree == {"Unoa": 1, "Dosa": 1, "Tresa": 0, "Dosb": 0}


def test_enlaces_se_rehacen_al_editar_y_se_borran_con_la_nota(db):
    upsert_notes(db, SOURCE, "Vault", [note(1, "Uno", "[[Dos]]"), note(2, "Dos", "")])
    upsert_notes(db, SOURCE, "Vault", [Note(ref(1), "Uno", "", "rev9", "x", "ya sin enlaces")])
    assert graph(db, None, VectorCache(), False, False)["edges"] == []
    upsert_notes(db, SOURCE, "Vault", [Note(ref(1), "Uno", "", "rev10", "x", "[[Dos]]")])
    db.execute("DELETE FROM item WHERE ref = ?", (ref(2),))
    assert db.execute("SELECT count(*) FROM note_link").fetchone()[0] == 1, "el enlace queda colgando sin destino"
    assert graph(db, None, VectorCache(), False, False)["edges"] == []


def test_modo_discreto_solo_muestra_notas_normales(db):
    upsert_notes(db, SOURCE, "Vault", [
        note(1, "Uno", "[[Secreta]] [[Local]]"),
        note(2, "Secreta", "---\nconfidencialidad: privado\n---\nnada"),
        note(3, "Local", "---\nconfidencialidad: solo-local\n---\nnada"),
    ])
    full = graph(db, None, VectorCache(), discreet=False, near=False)
    assert len(full["nodes"]) == 3 and len(full["edges"]) == 2
    discreet = graph(db, None, VectorCache(), discreet=True, near=False)
    assert [n["title"] for n in discreet["nodes"]] == ["Uno"] and discreet["edges"] == [] and discreet["total"] == 1


def test_cercania_por_significado_une_notas_del_mismo_tema(db):
    notes = [note(n, f"Dinero {n}", "factura iva trimestre gasto") for n in range(1, 4)]
    notes += [note(n, f"Viaje {n}", "vuelo hotel maleta") for n in range(4, 7)]
    notes += [note(n, f"Otra{n}", "suelta") for n in range(7, 13)]
    upsert_notes(db, SOURCE, "Vault", notes)
    embedder = TopicEmbedder()
    while embed_pending(db, embedder):
        pass
    result = graph(db, embedder, VectorCache(), discreet=False, near=True)
    assert result["semantic"]
    titles = {n["id"]: n["title"] for n in result["nodes"]}
    near = [(titles[e["a"]].split()[0], titles[e["b"]].split()[0]) for e in result["edges"] if e["kind"] == "near"]
    assert near and all(a == b and a in ("Dinero", "Viaje") for a, b in near)
    assert not graph(db, embedder, VectorCache(), discreet=False, near=False)["edges"]


def test_grafo_por_api_exige_secreto(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET}
        body = {"source": SOURCE, "sourceName": "Vault", "notes": [
            {"ref": ref(1), "title": "Uno", "folder": "", "revision": "r1", "modifiedAt": "x", "text": "[[Dos]]"},
            {"ref": ref(2), "title": "Dos", "folder": "", "revision": "r1", "modifiedAt": "x", "text": "x"}]}
        client.post("/internal/index/notes", json=body, headers=headers)
        assert client.get("/graph").status_code == 401
        found = client.get("/graph", params={"discreet": "1"}, headers=headers).json()
        assert len(found["nodes"]) == 2 and found["edges"][0]["kind"] == "link"


def test_migracion_olvida_revisiones_para_reindexar(tmp_path, monkeypatch):
    from agora_core import db as database

    every = database.available_migrations()
    connection = connect(tmp_path / DB_NAME)
    try:
        monkeypatch.setattr(database, "available_migrations", lambda: [m for m in every if m[0] < 6])
        migrate(connection)
        connection.execute(
            """INSERT INTO item (class, source, ref, title, revision, created_at, updated_at)
               VALUES ('note', ?, ?, 'Uno', 'r1', 'x', 'x')""", (SOURCE, ref(1)))
        monkeypatch.setattr(database, "available_migrations", lambda: every)
        assert migrate(connection) == [6]
        assert connection.execute("SELECT revision FROM item").fetchone()[0] is None
    finally:
        connection.close()
