"""Zernio's client: the key only in the Authorization header and never in an error, clear states for each failure,
pages by cursor and requests spaced to stay under 60 per minute. Zernio is a stand-in with invented data."""

import httpx
import pytest

from agora_core import zernio

KEY = "sk_prueba_0123456789abcdef"


@pytest.fixture(autouse=True)
def no_pause(monkeypatch):
    monkeypatch.setattr(zernio, "PAUSE", 0)


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_pide_con_la_clave_en_la_cabecera_y_pagina_por_cursor():
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        if request.url.path == "/api/v1/accounts":
            return httpx.Response(200, json={"accounts": [{"_id": "acc_1", "platform": "whatsapp", "metadata": {"displayPhoneNumber": "+34 600 111 222"}}]})
        if request.url.path == "/api/v1/inbox/conversations":
            if request.url.params.get("cursor") == "c2":
                return httpx.Response(200, json={"data": [{"id": "conv_2"}], "pagination": {"hasMore": False, "nextCursor": None}})
            return httpx.Response(200, json={"data": [{"id": "conv_1"}], "pagination": {"hasMore": True, "nextCursor": "c2"}})
        return httpx.Response(200, json={"messages": [{"id": "m1"}], "sortOrderApplied": request.url.params.get("sortOrder", "asc"), "pagination": {"hasMore": False}})

    http = client(handler)
    assert zernio.accounts(KEY, http)[0]["_id"] == "acc_1"
    first, cursor = zernio.conversations(KEY, client=http)
    assert [c["id"] for c in first] == ["conv_1"] and cursor == "c2"
    second, cursor = zernio.conversations(KEY, cursor, client=http)
    assert [c["id"] for c in second] == ["conv_2"] and cursor is None
    found, cursor = zernio.messages(KEY, "acc_1", "conv/1", client=http)
    assert found == [{"id": "m1"}] and cursor is None
    assert all(r.url.host == "zernio.com" and r.headers["authorization"] == f"Bearer {KEY}" for r in seen)
    assert all(KEY not in str(r.url) for r in seen), "la clave nunca va en la dirección"
    last = seen[-1]
    assert last.url.params["accountId"] == "acc_1" and last.url.params["limit"] == "100" and last.url.params["sortOrder"] == "desc"
    listing = next(r for r in seen if r.url.path == "/api/v1/inbox/conversations")
    assert listing.url.params["platform"] == "whatsapp" and listing.url.params["sortOrder"] == "desc", "solo WhatsApp, lo reciente primero"
    assert last.url.raw_path.startswith(b"/api/v1/inbox/conversations/conv%2F1/messages"), "el id no puede salirse de la ruta"
    assert all(r.method == "GET" for r in seen), "solo lectura"


@pytest.mark.parametrize(("status", "state"), [(401, "auth"), (403, "auth"), (429, "unreachable"), (503, "unreachable"), (400, "error")])
def test_cada_fallo_deja_un_estado_claro_sin_la_clave(status, state):
    http = client(lambda request: httpx.Response(status, json={"error": f"invalid key {KEY}"}))
    with pytest.raises(zernio.ZernioError) as caught:
        zernio.accounts(KEY, http)
    assert caught.value.status == state
    assert KEY not in str(caught.value)
    if status in (401, 403):
        assert "clave" in str(caught.value)


def test_sin_red_o_respuesta_rara():
    def offline(request):
        raise httpx.ConnectError("sin red", request=request)
    with pytest.raises(zernio.ZernioError) as caught:
        zernio.accounts(KEY, client(offline))
    assert caught.value.status == "unreachable" and KEY not in str(caught.value)
    with pytest.raises(zernio.ZernioError) as caught:
        zernio.accounts(KEY, client(lambda request: httpx.Response(200, text="<html>")))
    assert caught.value.status == "error"
    with pytest.raises(zernio.ZernioError) as caught:
        zernio.accounts("", client(lambda request: httpx.Response(200, json={})))
    assert caught.value.status == "auth"


def test_espacia_las_peticiones(monkeypatch):
    monkeypatch.setattr(zernio, "PAUSE", 1.0)
    clock = [100.0]
    slept = []
    monkeypatch.setattr(zernio.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(zernio.time, "sleep", lambda seconds: (slept.append(seconds), clock.__setitem__(0, clock[0] + seconds)))
    monkeypatch.setattr(zernio, "_last", 0.0)
    http = client(lambda request: httpx.Response(200, json={"accounts": []}))
    zernio.accounts(KEY, http)
    zernio.accounts(KEY, http)
    assert slept == [1.0], "como mucho una petición por segundo: 60 por minuto"


def test_rechaza_mensajes_que_no_vengan_del_mas_nuevo_al_mas_antiguo():
    http = client(lambda request: httpx.Response(200, json={"messages": [{"id": "m1"}], "sortOrderApplied": "asc"}))
    with pytest.raises(zernio.ZernioError) as caught:
        zernio.messages(KEY, "acc_1", "conv_1", client=http)
    assert caught.value.status == "error"
