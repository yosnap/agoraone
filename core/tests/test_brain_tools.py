import asyncio
import json
from contextlib import contextmanager

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import engines
from agora_core.app import SECRET_HEADER, create_app
from agora_core.brain_tools import Toolbox
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache
from agora_core.engines import ClaudeCodeEngine, CompatibleEngine, Turn
from agora_core.index import Note, upsert_notes
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

from test_assistant import OWNER, SECRET, SOURCE, MemorySecrets, events

NOTES = [
    ("Ponencia", "Ideas para la ponencia sobre agentes"),
    ("Diario", "---\nconfidencialidad: privado\n---\nponencia secreta sobre agentes"),
    ("Fiscal", "---\nconfidencialidad: solo-local\n---\nponencia y facturas de agentes"),
    ("Viaje", "Hotel y vuelo para el congreso de agentes\n[línea oculta 1]"),
]


def ref(n):
    return "note-" + f"{n:024x}"


@pytest.fixture
def toolbox(tmp_path):
    path = tmp_path / DB_NAME
    connection = connect(path)
    migrate(connection)
    upsert_notes(connection, SOURCE, "Vault", [Note(ref(n), t, "", "r", "x", text) for n, (t, text) in enumerate(NOTES)])
    connection.close()

    @contextmanager
    def database():
        opened = connect(path)
        try:
            yield opened
        finally:
            opened.close()
    return Toolbox(database, None, VectorCache(), max_calls=4)


def run(coroutine):
    return asyncio.run(coroutine)


def test_buscar_nunca_da_notas_privadas_ni_solo_locales(toolbox):
    found = json.loads(run(toolbox.call("buscar_en_cerebro", {"consulta": "ponencia agentes"})))
    titles = {note["titulo"] for note in found["notas"]}
    assert titles and titles <= {"Ponencia", "Viaje"} and "aviso" in found
    assert toolbox.drain()[0]["tool"] == "search" and toolbox.drain() == []


def test_leer_solo_por_numero_ya_encontrado(toolbox):
    assert "error" in json.loads(run(toolbox.call("leer_nota", {"n": 1}))), "no se puede leer sin haberla encontrado"
    run(toolbox.call("buscar_en_cerebro", {"consulta": "congreso hotel"}))
    read = json.loads(run(toolbox.call("leer_nota", {"n": 1})))
    assert read["titulo"] == "Viaje" and "vuelo" in read["texto"] and read["partes"] == 1
    assert [e["tool"] for e in toolbox.drain()] == ["search", "read"]
    again = json.loads(run(toolbox.call("buscar_en_cerebro", {"consulta": "hotel vuelo"})))
    assert again["notas"][0]["n"] == 1, "una nota encontrada otra vez conserva su número"


def test_tope_de_llamadas_y_argumentos_raros(toolbox):
    assert "error" in json.loads(run(toolbox.call("borrar_todo", {})))
    assert "error" in json.loads(run(toolbox.call("leer_nota", {"n": "x"})))
    for _ in range(2):
        run(toolbox.call("buscar_en_cerebro", {"consulta": "agentes"}))
    assert "límite" in json.loads(run(toolbox.call("buscar_en_cerebro", {"consulta": "agentes"})))["error"]


class ToolEngine:
    """Asks the brain twice before writing, as a real model would."""

    name = "claude-code"

    def available(self):
        return True

    async def stream(self, turn: Turn):
        found = json.loads(await turn.toolbox.call("buscar_en_cerebro", {"consulta": "congreso hotel"}))
        yield None
        n = found["notas"][0]["n"]
        await turn.toolbox.call("leer_nota", {"n": n})
        yield None
        yield f"Tienes el viaje del congreso [{n}]."


def test_turno_con_herramientas_emite_lo_que_hace_y_guarda_lo_citado(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets(), engines=lambda s, k: [ToolEngine()])
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        notes = [{"ref": ref(n), "title": t, "folder": "", "revision": "r", "modifiedAt": "x", "text": text} for n, (t, text) in enumerate(NOTES)]
        client.post("/internal/index/notes", json={"source": SOURCE, "sourceName": "Vault", "notes": notes}, headers=headers)
        conversation = client.post("/assistant/conversations", headers=headers).json()
        response = client.post(f"/assistant/conversations/{conversation['id']}/messages", json={"message": "¿Qué tengo de la ponencia?"}, headers=headers)
        found = events(response.text)
        tools = [data for kind, data in found if kind == "tool"]
        assert [t["tool"] for t in tools] == ["search", "read"] and tools[1]["title"] == "Viaje"
        every = [s["title"] for kind, data in found if kind == "sources" for s in data["sources"]]
        assert "Diario" not in every and "Fiscal" not in every
        stored = client.get(f"/assistant/conversations/{conversation['id']}", headers=headers).json()["messages"][-1]
        assert [s["title"] for s in stored["sources"]] == ["Viaje"], "se guardan las notas citadas"


class LateToolEngine:
    """Like Claude Code: announces the tool round first and the tool runs afterwards, then writes."""

    name = "claude-code"

    def available(self):
        return True

    async def stream(self, turn: Turn):
        yield None
        await turn.toolbox.call("proponer_evento", {"titulo": "Reunión con Acme", "inicio": "2026-11-20T10:00"})
        yield "Te lo dejo en pantalla para que lo confirmes."


def test_la_propuesta_de_la_ultima_herramienta_llega_a_la_pantalla(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets(), engines=lambda s, k: [LateToolEngine()])
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        conversation = client.post("/assistant/conversations", headers=headers).json()
        response = client.post(f"/assistant/conversations/{conversation['id']}/messages", json={"message": "Apunta la reunión"}, headers=headers)
        tools = [data for kind, data in events(response.text) if kind == "tool"]
        assert [t["tool"] for t in tools] == ["event_proposal"], "la tarjeta del evento llega aunque la herramienta corra tras la ronda"
        assert tools[0]["event"]["title"] == "Reunión con Acme"


def test_claude_code_solo_con_las_herramientas_del_cerebro(toolbox):
    options = ClaudeCodeEngine().options(Turn("s", [{"role": "user", "content": "x"}], "sonnet", toolbox))
    assert options.tools == [] and options.strict_mcp_config is True and options.setting_sources == []
    assert list(options.mcp_servers) == ["cerebro"]
    assert sorted(options.allowed_tools) == ["mcp__cerebro__buscar_en_cerebro", "mcp__cerebro__consultar_agenda", "mcp__cerebro__consultar_bandeja", "mcp__cerebro__consultar_clientes", "mcp__cerebro__consultar_reuniones", "mcp__cerebro__consultar_trabajos", "mcp__cerebro__leer_nota", "mcp__cerebro__leer_reunion", "mcp__cerebro__proponer_encargo_orca", "mcp__cerebro__proponer_evento", "mcp__cerebro__proponer_issue", "mcp__cerebro__proponer_limpieza", "mcp__cerebro__proponer_nota", "mcp__cerebro__proponer_presupuesto", "mcp__cerebro__proponer_regla", "mcp__cerebro__proponer_reorganizacion", "mcp__cerebro__resumen_del_dia", "mcp__cerebro__revisar_vault"]


def test_proveedor_compatible_con_bucle_de_herramientas(toolbox, monkeypatch):
    rounds = []

    def reply(request: httpx.Request):
        body = json.loads(request.content)
        rounds.append(body)
        if len(rounds) == 1:
            chunks = [{"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "buscar_en_", "arguments": '{"consulta":'}}]},
                      {"tool_calls": [{"index": 0, "function": {"name": "cerebro", "arguments": ' "hotel"}'}}]}]
        else:
            chunks = [{"content": "Respuesta [1]."}]
        text = "".join(f"data: {json.dumps({'choices': [{'delta': c}]})}\n\n" for c in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, text=text)
    real = httpx.AsyncClient
    monkeypatch.setattr(engines.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(reply), **kw))
    monkeypatch.setattr(engines, "resolves_public", lambda url: True)
    secrets = MemorySecrets()
    secrets.put("openai-compatible-key", "k" * 20)
    engine = CompatibleEngine(secrets, "https://proveedor.example/v1", "modelo")

    async def collect():
        return [part async for part in engine.stream(Turn("s", [{"role": "user", "content": "x"}], "m", toolbox))]
    parts = run(collect())
    assert parts == [None, "Respuesta [1]."]
    assert rounds[0]["tools"][0]["function"]["name"] == "buscar_en_cerebro"
    tool_message = rounds[1]["messages"][-1]
    assert tool_message["role"] == "tool" and tool_message["tool_call_id"] == "c1" and "Viaje" in tool_message["content"]
