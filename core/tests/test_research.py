import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from agora_core import assistant, research, web_page
from agora_core.app import SECRET_HEADER, create_app
from agora_core.brain_tools import Toolbox
from agora_core.engines import ClaudeCodeEngine, Turn, _specs
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

from test_assistant import OWNER, SECRET, FakeEngine, MemorySecrets, events


def run(coro):
    return asyncio.run(coro)


def app_with(tmp_path, engine):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets(), engines=lambda s, k: [engine])
    return TestClient(app, base_url=f"http://{settings.authority}"), {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}


def test_watson_solo_propone_la_investigacion():
    box = Toolbox(None, None, None)
    answer = json.loads(run(box.call("proponer_investigacion", {"pregunta": "  Precio medio  del kWh en España ", "alcance": "2026"})))
    assert "No se ha buscado nada" in answer["estado"]
    assert box.events[-1] == {"tool": "research_proposal", "proposal": {"question": "Precio medio del kWh en España", "scope": "2026"}}
    assert "error" in json.loads(run(box.call("proponer_investigacion", {"pregunta": " "})))


def test_watson_no_lee_paginas_fuera_de_una_investigacion(monkeypatch):
    async def never(url, client=None):
        raise AssertionError("no debía abrir nada")
    monkeypatch.setattr(web_page, "fetch", never)
    box = Toolbox(None, None, None)
    assert "no está disponible" in run(box.call("leer_pagina", {"url": "https://example.com"}))
    assert "leer_pagina" not in [spec["name"] for spec in _specs()]


def test_la_investigacion_no_tiene_herramientas_privadas():
    box = Toolbox(None, None, None)
    box.only = research.TOOLS
    for private in ("consultar_bandeja", "consultar_clientes", "proponer_encargo_hermes", "proponer_respuesta_whatsapp"):
        assert "no está disponible" in run(box.call(private, {}))
    names = [spec["name"] for spec in _specs(names=(*research.TOOLS, "consultar_bandeja"))]
    assert names == ["buscar_en_cerebro", "leer_nota", "proponer_nota", "leer_pagina"]


def test_leer_pagina_con_el_lector_comprobado_y_con_tope(monkeypatch):
    seen = []

    async def fetch(url, client=None):
        seen.append(url)
        return web_page.Page(url, url, "Título", "x" * (research.PAGE_CHARS + 10), False)
    monkeypatch.setattr(web_page, "fetch", fetch)
    box = Toolbox(None, None, None)
    box.only, box.pages_left = research.TOOLS, 1
    first = run(box.call("leer_pagina", {"url": "https://example.com/a"}))
    assert "<paginas_web" in first and 'recortada="sí"' in first and seen == ["https://example.com/a"]
    assert box.events[-1] == {"tool": "web", "pages": [{"host": "example.com", "ok": True}]}
    assert "todas las páginas" in run(box.call("leer_pagina", {"url": "https://example.com/b"}))
    box.pages_left = 3
    assert "no es una dirección" in run(box.call("leer_pagina", {"url": "file:///etc/passwd"}))
    assert len(seen) == 1


def test_claude_code_busca_en_anthropic_y_nunca_descarga_desde_este_mac():
    box = Toolbox(None, None, None)
    options = ClaudeCodeEngine().options(Turn("s", [{"role": "user", "content": "x"}], "sonnet", box, research.TOOLS, 5))
    assert options.tools == ["WebSearch"] and "WebFetch" not in options.allowed_tools
    assert sorted(options.allowed_tools) == ["WebSearch", "mcp__cerebro__buscar_en_cerebro", "mcp__cerebro__leer_nota",
                                             "mcp__cerebro__leer_pagina", "mcp__cerebro__proponer_nota"]
    normal = ClaudeCodeEngine().options(Turn("s", [{"role": "user", "content": "x"}], "sonnet", box))
    assert normal.tools == [] and "WebSearch" not in normal.allowed_tools


def test_el_turno_de_investigacion_va_aparte_de_la_conversacion(tmp_path):
    engine = FakeEngine(reply=("Informe.",))
    client, headers = app_with(tmp_path, engine)
    with client:
        conversation = client.post("/assistant/conversations", headers=headers).json()
        path = f"/assistant/conversations/{conversation['id']}/messages"
        client.post(path, headers=headers, json={"message": "Mi cliente secreto es Acme"})
        response = client.post(path, headers=headers, json={"message": "Investiga: tarifas de luz",
                                                              "research": {"question": "Tarifas de luz en España", "scope": "solo 2026"}})
        assert events(response.text)[-1][0] == "done"
        turn = engine.turns[-1]
        assert len(turn.messages) == 1 and "Acme" not in turn.messages[0]["content"], "sin el historial de la conversación"
        assert "Investiga: Tarifas de luz en España" in turn.messages[0]["content"]
        assert turn.tools == research.TOOLS and turn.searches == research.DEFAULTS["searches"]
        assert "INVESTIGACIÓN" in turn.system and "solo 2026" in turn.system and "Investigaciones" in turn.system
        assert turn.toolbox.only == research.TOOLS and turn.toolbox.pages_left == research.DEFAULTS["pages"]


def test_los_topes_se_guardan_en_ajustes_y_se_validan(tmp_path):
    client, headers = app_with(tmp_path, FakeEngine())
    with client:
        saved = client.put("/assistant/settings", headers=headers, json={"research": {"searches": 3}})
        assert saved.status_code == 200 and saved.json()["research"] == {"searches": 3, "pages": 6, "minutes": 4}
        for bad in ({"searches": 99}, {"busquedas": 3}, {"minutes": True}):
            assert client.put("/assistant/settings", headers=headers, json={"research": bad}).status_code == 422
    assert research.limits({"research": {"searches": 50}})["searches"] == 20


def test_la_investigacion_tiene_tiempo_maximo(tmp_path, monkeypatch):
    class Slow(FakeEngine):
        async def stream(self, turn):
            self.turns.append(turn)
            await asyncio.sleep(2)
            yield "tarde"
    monkeypatch.setattr(research, "limits", lambda settings: {"searches": 1, "pages": 1, "minutes": 0.005})
    client, headers = app_with(tmp_path, Slow())
    with client:
        conversation = client.post("/assistant/conversations", headers=headers).json()
        response = client.post(f"/assistant/conversations/{conversation['id']}/messages", headers=headers,
                               json={"message": "Investiga: x", "research": {"question": "x"}})
        kind, data = events(response.text)[-1]
        assert kind == "error" and "minutos" in data["error"]


def test_el_proveedor_compatible_investiga_sin_buscador():
    prompt = research.system_prompt("Base.", "", 5, can_search=False)
    assert "no tiene buscador" in prompt and "leer_pagina" in prompt
    assert assistant.DEFAULTS["research"] == research.DEFAULTS
