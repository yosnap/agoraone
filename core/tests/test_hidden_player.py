"""The hidden YouTube window: the screen's orders wait for the desktop app, only valid orders pass, an app that starts
never replays an old one, and without the desktop app the screen is told there is no window."""

import asyncio

from fastapi.testclient import TestClient

from agora_core import hidden_player
from agora_core.app import SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

from test_assistant import OWNER, SECRET, MemorySecrets


def test_ordenes_validas():
    assert hidden_player.valid({"action": "play", "id": "5g2hT4GmAGU", "volume": 3}) == {"action": "play", "id": "5g2hT4GmAGU"}
    assert hidden_player.valid({"action": "play", "id": "javascript:x"}) is None
    assert hidden_player.valid({"action": "volume", "volume": 140}) is None
    assert hidden_player.valid({"action": "volume", "volume": 40.6}) == {"action": "volume", "volume": 40}
    assert hidden_player.valid({"action": "seek", "seconds": -1}) is None
    assert hidden_player.valid({"action": "borrar"}) is None
    assert hidden_player.valid({"action": "pause"}) == {"action": "pause"}


def test_el_relevo_espera_y_no_repite():
    async def scenario():
        relay = hidden_player.Relay()
        assert not relay.available()
        relay.push({"action": "play", "id": "5g2hT4GmAGU"})
        start = await relay.next(-1)
        assert start == {"seq": 1, "commands": []}, "al arrancar no se repite una orden vieja"
        assert relay.available()
        waiting = asyncio.create_task(relay.next(1, wait=5))
        await asyncio.sleep(0.01)
        relay.push({"action": "pause"})
        got = await waiting
        assert got["commands"] == [{"seq": 2, "action": "pause"}]
        assert (await relay.next(2, wait=0.01))["commands"] == []
    asyncio.run(scenario())


def test_rutas(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        assert client.get("/music/youtube/hidden", headers=headers).json() == {"available": False}
        refused = client.post("/music/youtube/hidden", json={"action": "play", "id": "5g2hT4GmAGU"}, headers=headers)
        assert refused.status_code == 409, "sin la app de escritorio no hay ventana"
        assert client.get("/internal/youtube/hidden/next", headers=headers).json() == {"seq": 0, "commands": []}
        assert client.get("/music/youtube/hidden", headers=headers).json() == {"available": True}
        assert client.post("/music/youtube/hidden", json={"action": "play", "id": "x"}, headers=headers).status_code == 400
        assert client.post("/music/youtube/hidden", json={"action": "play", "id": "5g2hT4GmAGU"}, headers=headers).json() == {"seq": 1}
        got = client.get("/internal/youtube/hidden/next?after=0", headers=headers).json()
        assert got == {"seq": 1, "commands": [{"seq": 1, "action": "play", "id": "5g2hT4GmAGU"}]}
