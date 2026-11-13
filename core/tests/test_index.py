import hashlib
import re

import pytest
from fastapi.testclient import TestClient

from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import EmbedError, VectorCache, embed_pending
from agora_core.index import Note, chunks, declared_level, remove_notes, replace_folder_rules, state, status, upsert_notes
from agora_core.keystore import MemoryStore
from agora_core.search import fts_query, search
from agora_core.settings import load_settings

SOURCE = "vault-" + "a" * 24
SECRET = "a" * 64
CONCEPTS = {"dinero": ("factura", "iva", "trimestre", "gasto"), "viaje": ("vuelo", "hotel", "maleta")}


class FakeEmbedder:
    """Words of the same concept land on the same dimension: enough to test search by meaning."""

    model = "falso"

    def __init__(self, fail=False):
        self.fail = fail

    def embed(self, texts):
        if self.fail:
            raise EmbedError("sin ollama")
        vectors = []
        for text in texts:
            vector = [0.0] * 8
            for word in re.findall(r"\w+", text.lower()):
                for n, (concept, words) in enumerate(CONCEPTS.items()):
                    if word == concept or word in words:
                        vector[n] += 1
                vector[2 + int(hashlib.sha256(word.encode()).hexdigest(), 16) % 6] += 0.05
            vectors.append(vector)
        return vectors


def ref(n):
    return "note-" + f"{n:024x}"


def note(n, title, text, folder=""):
    return Note(ref(n), title, folder, f"rev{n}", "2026-11-13T10:00:00Z", text)


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def test_fragmentos_por_parrafos_y_encabezados():
    text = "---\ntags: x\n---\nIntro.\n\n# Sección\n\n" + ("palabra " * 300)
    pieces = chunks("Título", text)
    assert all(p.startswith("Título\n\n") for p in pieces)
    assert "tags: x" not in "".join(pieces), "las propiedades no se indexan como texto"
    assert pieces[0].endswith("Intro."), "un encabezado empieza fragmento nuevo"
    assert all(len(p) <= 1000 + len("Título\n\n") for p in pieces)
    assert chunks("Vacía", "") == ["Vacía"]


@pytest.mark.parametrize("value, level", [
    ("privado", "private"), ("Solo-Local", "local_only"), ("normal", "normal"), ("'privado'", "private"),
    ("algo raro", "private"),
])
def test_confidencialidad_declarada(value, level):
    assert declared_level(f"---\nconfidencialidad: {value}\n---\ntexto") == level
    assert declared_level("sin propiedades\nconfidencialidad: privado") == "normal", "solo cuenta en las propiedades"


def test_alta_cambio_y_baja_incremental(db):
    upsert_notes(db, SOURCE, "Vault", [note(1, "Uno", "hola"), note(2, "Dos", "adiós")])
    assert state(db, SOURCE) == {ref(1): "rev1", ref(2): "rev2"}
    upsert_notes(db, SOURCE, "Vault", [Note(ref(1), "Uno", "", "rev9", "x", "cambiado")])
    assert state(db, SOURCE)[ref(1)] == "rev9"
    assert db.execute("SELECT count(*) FROM chunk").fetchone()[0] == 2, "los fragmentos viejos se sustituyen"
    assert remove_notes(db, SOURCE, [ref(2)]) == 1
    assert state(db, SOURCE) == {ref(1): "rev9"}
    assert db.execute("SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH 'adios'").fetchone()[0] == 0


def test_busqueda_por_palabras_sin_tildes(db):
    upsert_notes(db, SOURCE, "Vault", [note(1, "Reunión", "Hablamos de la reunión con Álvaro sobre la ponencia")])
    found = search(db, "reunion alvaro", None, VectorCache())
    assert [r["ref"] for r in found["results"]] == [ref(1)]
    assert found["semantic"] is False
    assert "«" in found["results"][0]["snippet"]
    assert fts_query('"; DROP TABLE item; --') is not None, "la sintaxis del usuario se neutraliza"
    assert search(db, '"; DROP TABLE item; --', None, VectorCache())["results"] == []


def test_busqueda_por_significado_y_fusion(db):
    upsert_notes(db, SOURCE, "Vault", [
        note(1, "Trimestre", "Hay que revisar la factura y el IVA"),
        note(2, "Vacaciones", "Reservar vuelo y hotel"),
    ])
    embedder = FakeEmbedder()
    while embed_pending(db, embedder):
        pass
    found = search(db, "dinero", embedder, VectorCache())
    assert found["semantic"] is True
    assert found["results"][0]["ref"] == ref(1), "encuentra la nota sin compartir palabras"
    assert found["results"][0]["matchedBy"] == ["meaning"]


def test_sin_ollama_busca_solo_por_palabras(db):
    upsert_notes(db, SOURCE, "Vault", [note(1, "Trimestre", "factura")])
    found = search(db, "factura", FakeEmbedder(fail=True), VectorCache())
    assert found["semantic"] is False and found["results"][0]["ref"] == ref(1)


def test_confidencialidad_reglas_de_carpeta_y_filtro(db):
    upsert_notes(db, SOURCE, "Vault", [
        note(1, "Pública", "proyecto agora"),
        note(2, "Impuestos", "proyecto agora", folder="Fiscal/2026"),
        note(3, "Diario", "---\nconfidencialidad: privado\n---\nproyecto agora"),
    ])
    levels = lambda: dict(db.execute("SELECT ref, confidentiality FROM item").fetchall())  # noqa: E731
    assert levels() == {ref(1): "normal", ref(2): "normal", ref(3): "private"}
    assert replace_folder_rules(db, [(SOURCE, "fiscal", "local_only")]) == 1
    assert levels()[ref(2)] == "local_only", "la regla abarca subcarpetas y no distingue mayúsculas"
    assert replace_folder_rules(db, [("*", "Fiscal", "private")]) == 1
    assert levels()[ref(2)] == "private"
    replace_folder_rules(db, [])
    assert levels()[ref(2)] == "normal" and levels()[ref(3)] == "private", "lo declarado en la nota se mantiene"
    found = search(db, "agora", None, VectorCache(), exclude=("private",))
    assert {r["ref"] for r in found["results"]} == {ref(1), ref(2)}
    assert status(db)["byConfidentiality"] == {"normal": 2, "private": 1}


def test_embeddings_se_rehacen_si_cambia_el_texto(db):
    upsert_notes(db, SOURCE, "Vault", [note(1, "Uno", "factura")])
    embedder = FakeEmbedder()
    embed_pending(db, embedder)
    assert status(db)["pendingEmbeddings"] == 0
    upsert_notes(db, SOURCE, "Vault", [Note(ref(1), "Uno", "", "rev2", "x", "hotel")])
    assert status(db)["pendingEmbeddings"] == 1


def test_rutas_internas_y_busqueda_por_api(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET}
        body = {"source": SOURCE, "sourceName": "Vault", "notes": [
            {"ref": ref(1), "title": "Ponencia", "folder": "", "revision": "r1", "modifiedAt": "x", "text": "agentes y memoria"}]}
        assert client.post("/internal/index/notes", json=body, headers=headers).json() == {"indexed": 1}
        assert client.get("/internal/index/state", params={"source": SOURCE}, headers=headers).json() == {"refs": {ref(1): "r1"}}
        bad = dict(body, notes=[dict(body["notes"][0], ref="../../etc/passwd")])
        assert client.post("/internal/index/notes", json=bad, headers=headers).status_code == 422
        found = client.get("/search", params={"q": "memoria"}, headers=headers).json()
        assert found["results"][0]["title"] == "Ponencia"
        rules = {"rules": [{"source": "*", "folder": "Privado", "confidentiality": "private"}]}
        assert client.put("/index/folder-rules", json=rules, headers=headers).status_code == 200
        assert client.get("/index/folder-rules", headers=headers).json()["rules"][0]["folder"] == "Privado"
        assert client.get("/index/status", headers=headers).json()["notes"] == 1
        assert client.post("/internal/index/remove", json={"source": SOURCE, "refs": [ref(1)]}, headers=headers).json() == {"removed": 1}
        assert client.get("/search", params={"q": "memoria"}).status_code == 401


def test_significado_sin_parecido_real_no_cuenta(db):
    """With a large enough index, fragments that do not stand out from the rest are not results."""
    import numpy as np

    class Fixed:
        model = "fijo"

        def __init__(self, query):
            self.query = query

        def embed(self, texts):
            return [self.query for _ in texts]

    rng = np.random.default_rng(7)
    notes = [note(n, f"N{n}", f"texto {n}") for n in range(80)]
    upsert_notes(db, SOURCE, "Vault", notes)
    ids = [r[0] for r in db.execute("SELECT id FROM chunk ORDER BY id")]
    noise = rng.normal(size=(len(ids), 16)).astype(np.float32)
    target = noise[3] / np.linalg.norm(noise[3])
    for chunk_id, vector in zip(ids, noise):
        db.execute("UPDATE chunk SET embedding = ?, embed_model = 'fijo' WHERE id = ?", ((vector / np.linalg.norm(vector)).tobytes(), chunk_id))
    cache = VectorCache()
    assert cache.nearest(db, Fixed(list(target)), "x") == [ids[3]], "solo el que destaca de verdad"
    assert cache.nearest(db, Fixed(list(rng.normal(size=16))), "x") == [], "nada destaca: ningún resultado"
