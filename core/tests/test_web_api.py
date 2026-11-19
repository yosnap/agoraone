"""The shared web API layer with a made-up service: http only on loopback, redirections never followed (the key never
reaches the other host), the key scrubbed from what the service says, size cap, plain errors for 401, 403, 404,
429 and a timeout, and the key kept only in its own account of the secret store."""

import httpx
import pytest

from agora_core import web_api
from test_assistant import MemorySecrets

KEY = "tk_" + "a1B2-" * 8
URL = "https://servicio.example.com"
TARGET = web_api.Connection(URL, KEY)
ANSWER: list = []  # the handler of the current test


def transport() -> httpx.BaseTransport:
    return httpx.MockTransport(lambda request: ANSWER[0](request))


SPEC = web_api.WebApiSpec(
    secret="test-key", setting="test.connection", key_pattern=r"tk_[A-Za-z0-9_-]{40}", key_hint="empieza por «tk_»",
    key_source="Ajustes del Servicio", example_url=URL, name="Servicio", path_prefix="/api/", scopes=("leer",), transport=transport)


@pytest.fixture(autouse=True)
def handler():
    ANSWER.clear()
    yield ANSWER
    ANSWER.clear()


def answer(function):
    ANSWER[:] = [function]


def failure(path="/api/estado") -> web_api.WebApiError:
    with pytest.raises(web_api.WebApiError) as raised:
        web_api.request(SPEC, TARGET, "GET", path)
    assert KEY not in str(raised.value) and raised.value.__cause__ is None
    return raised.value


@pytest.mark.parametrize("url", ["http://servicio.example.com", "http://192.168.1.2:8080", "https://a..b", "https://x.com/?q=1", "", 7])
def test_solo_https_salvo_en_este_equipo(url):
    assert web_api.url_problem(SPEC, url)


def test_direcciones_de_este_equipo_y_mensajes_con_su_nombre():
    assert web_api.normalize_url(SPEC, "http://localhost:4000/") == "http://localhost:4000"
    assert web_api.normalize_url(SPEC, "http://[::1]:4000") == "http://[::1]:4000"
    assert "Servicio" in web_api.url_problem(SPEC, "http://servicio.example.com")
    assert web_api.same_origin(SPEC, URL, "https://SERVICIO.example.com:443/api") and not web_api.same_origin(SPEC, URL, "https://otro.example.com")
    assert web_api.key_problem(SPEC, KEY) is None and "tk_" in web_api.key_problem(SPEC, "cen_x")


def test_una_redireccion_no_se_sigue_ni_lleva_la_clave():
    seen = []

    def moved(request):
        seen.append((str(request.url), request.headers.get("authorization")))
        return httpx.Response(302, headers={"location": "https://otro.example.net/robar"})
    answer(moved)
    assert failure().status == "error"
    assert seen == [(f"{URL}/api/estado", f"Bearer {KEY}")], "nunca se pide al otro servidor"


def test_la_clave_se_borra_de_lo_que_dice_el_servicio():
    answer(lambda r: httpx.Response(422, json={"error": "invalid", "detail": f"la clave {KEY} no vale"}))
    error = failure()
    assert error.status == "invalid" and "***" in str(error)


def test_respuesta_demasiado_grande():
    answer(lambda r: httpx.Response(200, text="{" + " " * 2000 + "}"))
    with pytest.raises(web_api.WebApiError, match="demasiado grande"):
        web_api.request(SPEC, TARGET, "GET", "/api/estado", max_bytes=1000)


@pytest.mark.parametrize(("status", "state"), [(401, "auth"), (403, "forbidden"), (404, "not_found"), (429, "busy"), (503, "unreachable")])
def test_errores_en_palabras_claras(status, state):
    answer(lambda r: httpx.Response(status, json={"error": "x", "scope": "leer"}))
    error = failure()
    assert error.status == state and "Servicio" in str(error)
    if status == 403:
        assert "«leer»" in str(error)


def test_tiempo_agotado():
    def slow(request):
        raise httpx.ReadTimeout("lento", request=request)
    answer(slow)
    error = failure()
    assert error.status == "unreachable" and "a tiempo" in str(error)


def test_solo_rutas_de_su_api():
    answer(lambda r: pytest.fail("no se pide nada"))
    assert failure("/admin").status == "error"


def test_la_clave_solo_en_su_cuenta_del_almacen():
    secrets = MemorySecrets()
    secrets.put("otra-cuenta", "intocable")
    web_api.write_key(SPEC, secrets, KEY)
    assert secrets.values == {"otra-cuenta": "intocable", "test-key": KEY}
    assert web_api.read_key(SPEC, secrets) == KEY
    web_api.write_key(SPEC, secrets, None)
    assert secrets.values == {"otra-cuenta": "intocable"}
    assert KEY not in repr(TARGET)
