"""Keep all HTTPX connections on the native certificate store."""

import ast
from pathlib import Path

_CORE = Path(__file__).resolve().parents[1] / "agora_core"
_HTTPX_NETWORK = {
    "Client", "AsyncClient", "HTTPTransport", "AsyncHTTPTransport",
    "request", "stream", "get", "post", "put", "patch", "delete", "head", "options",
}


def test_las_conexiones_httpx_usan_los_certificados_del_sistema():
    missing = []
    for path in sorted(_CORE.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        nodes = list(ast.walk(tree))
        modules = {
            name.asname or name.name
            for node in nodes if isinstance(node, ast.Import)
            for name in node.names if name.name == "httpx"
        }
        imports = {
            name.asname or name.name
            for node in nodes if isinstance(node, ast.ImportFrom) and node.module == "httpx"
            for name in node.names if name.name in _HTTPX_NETWORK
        }
        network = imports | {f"{module}.{method}" for module in modules for method in _HTTPX_NETWORK}
        for call in (node for node in nodes if isinstance(node, ast.Call)):
            choices = call.func.values if isinstance(call.func, ast.BoolOp) else [call.func]
            if any(ast.unparse(choice) in network for choice in choices) and not any(
                arg.arg == "verify" and ast.unparse(arg.value) == "tls.client_context()" for arg in call.keywords
            ):
                missing.append(f"{path.relative_to(_CORE)}:{call.lineno} {ast.unparse(call.func)}")
    assert not missing, "Usa verify=tls.client_context() en las conexiones HTTPX:\n" + "\n".join(missing)
