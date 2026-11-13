import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

from agora_core.brain_mcp import Brain, build_server
from agora_core.db import DB_NAME, connect, migrate
from agora_core.index import Note, upsert_notes

SOURCE = "vault-" + "a" * 24


def ref(n):
    return "note-" + f"{n:024x}"


@pytest.fixture
def folder(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    upsert_notes(connection, SOURCE, "Vault", [
        Note(ref(1), "Ponencia", "Charlas", "r", "x", "Guion de la ponencia sobre agentes.\n\nSegunda parte."),
        Note(ref(2), "Diario", "", "r", "x", "---\nconfidencialidad: privado\n---\nponencia íntima sobre agentes"),
        Note(ref(3), "Fiscal", "", "r", "x", "---\nconfidencialidad: solo-local\n---\nponencia y facturas de agentes"),
    ])
    connection.close()
    return tmp_path


def test_solo_sale_lo_normal(folder):
    brain = Brain(folder, embedder=None)
    found = brain.search("ponencia agentes", 10)
    assert [r["title"] for r in found["results"]] == ["Ponencia"]
    assert "text" not in found["results"][0] and "confidentiality" not in found["results"][0]
    assert brain.read(SOURCE, ref(1))["text"] == "Guion de la ponencia sobre agentes.\n\nSegunda parte."
    assert brain.read(SOURCE, ref(2)) is None and brain.read(SOURCE, ref(3)) is None
    assert brain.status() == {"availableNotes": 1, "searchByMeaning": False}


def test_solo_lectura_y_sin_crear_nada(tmp_path):
    with pytest.raises(FileNotFoundError):
        Brain(tmp_path / "vacio", embedder=None).search("x", 5)
    assert not (tmp_path / "vacio").exists(), "no crea la base si no existe"


def test_herramientas_declaradas_de_solo_lectura(folder):
    server = build_server(Brain(folder, embedder=None))
    tools = asyncio.run(server.list_tools())
    assert {t.name for t in tools} == {"buscar_en_cerebro", "leer_nota", "estado_del_cerebro"}
    assert all(t.annotations.read_only_hint and not t.annotations.destructive_hint for t in tools)


def test_por_stdio_como_lo_usaria_hermes(folder):
    """The real thing: a client launches the server over stdio, lists tools and calls them."""
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    async def run():
        params = StdioServerParameters(
            command=sys.executable, args=["-m", "agora_core.brain_mcp"],
            env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "AGORA_CORE_DATA": str(folder),
                 "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
        )
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("buscar_en_cerebro", {"consulta": "ponencia", "limite": 5})
            found = result.structured_content or json.loads(result.content[0].text)
            bad = await session.call_tool("leer_nota", {"source": "../../etc", "ref": "x"})
            return found, bad.structured_content or json.loads(bad.content[0].text)

    found, bad = asyncio.run(run())
    assert [r["title"] for r in found["results"]] == ["Ponencia"]
    assert bad == {"error": "Referencia no válida."}
