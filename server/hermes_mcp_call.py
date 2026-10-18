"""Call one MCP tool of a profile by hand, with the arguments the user wrote and confirmed in AgoraOne.

Input (stdin, JSON): {"profile": <dir name>, "server": <name in its config.yaml>, "tool": <tool name>, "args": {...}}.
Output: one JSON line {"ok": true, "result": <text>} or {"ok": false, "error": <message for the user>}.

The call runs inside the profile's scope (its home, credentials and terminal policy, as Hermes' own
gateway does), connects only that one server through Hermes' MCP machinery, and shuts it down after.
The user's explicit confirmation in AgoraOne is the human approval for this one call, so Hermes' trust
gate for untrusted servers, which would otherwise ask a human that is not here, is passed for it. The
server may not ask Hermes' model to write for it (sampling) nor ask the user questions (elicitation)
during the call: both are switched off in memory for it, so nothing reaches the profile's provider.
"""
import contextlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# The exact Hermes commit these bridges were checked against, with no local changes to its tracked files.
EXPECTED_COMMIT = "28aceb3451f5a5d2a27396b2adf29231be34c482"
TIMEOUT = 90.0
LIMIT = 50_000  # characters of result returned to AgoraOne


class UserError(Exception):
    pass


def isolate_environment():
    """Importing Hermes loads the main profile's dotenv file into os.environ: removed again, so the MCP
    server started here only gets the chosen profile's own credentials (same as the chat bridge)."""
    before = dict(os.environ)
    import gateway.run  # noqa: F401
    import run_agent  # noqa: F401
    import tools.mcp_tool_config  # noqa: F401
    for name in [name for name in os.environ if name not in before]:
        del os.environ[name]
    os.environ.update(before)
    from agent.secret_scope import set_multiplex_active
    set_multiplex_active(True)


# Hermes' own failures (not the service's answer), explained in Spanish; «unknown» ones may have run.
HERMES_ERRORS = [
    (r"outcome is unknown|lost its stdio subprocess|timed? ?out|TimeoutError", "La llamada no terminó a tiempo o el servidor se cerró a mitad: no se sabe si la acción llegó a completarse en el servicio. Compruébalo antes de repetirla."),
    (r"unreachable|rejected the last|circuit", "El servidor MCP ha fallado varias veces seguidas y Hermes lo ha apartado por ahora. Inténtalo más tarde."),
    (r"transport is down|not connected|failed initial connection|connection closed", "No se pudo conectar con ese servidor MCP. Comprueba que funcione en Hermes."),
    (r"oauth|login|authoriz", "Este servidor necesita iniciar sesión (OAuth). Hazlo una vez desde un terminal con «hermes mcp login» para ese servidor y vuelve a intentarlo."),
]


def explain(message):
    for pattern, spanish in HERMES_ERRORS:
        if re.search(pattern, message, re.IGNORECASE):
            return spanish
    return None


def call(request):
    profile, server, tool, args = request.get("profile"), request.get("server"), request.get("tool"), request.get("args")
    if not isinstance(profile, str) or not re.fullmatch(r"(?!\.)[A-Za-z0-9_.-]{1,64}", profile):
        raise UserError("Perfil no válido.")
    if not isinstance(server, str) or not server or not isinstance(tool, str) or not tool or not isinstance(args, dict):
        raise UserError("Llamada no válida.")
    from gateway.run import _profile_runtime_scope
    from hermes_cli.profiles import get_profile_dir
    from tools import mcp_tool_handlers
    from tools import mcp_tool_config
    from tools.mcp_tool_discovery import discover_mcp_tools
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    load = mcp_tool_config._load_mcp_config

    def without_model_or_questions():
        servers = load() or {}
        if isinstance(servers.get(server), dict):
            servers[server] = {**servers[server], "sampling": {"enabled": False}, "elicitation": {"enabled": False}}
        return servers
    mcp_tool_config._load_mcp_config = without_model_or_questions
    with _profile_runtime_scope(Path(get_profile_dir(profile))):
        try:
            try:
                registered = discover_mcp_tools(allowed_mcp_names=[server])
            except Exception as error:
                if type(error).__name__ == "OAuthNonInteractiveError":
                    raise UserError(explain("oauth"))
                raise
            if not registered:
                raise UserError("No se pudo conectar con ese servidor MCP. Comprueba que funcione en Hermes.")
            mcp_tool_handlers._trust_gate_check = lambda *_args, **_kwargs: None
            raw = mcp_tool_handlers._make_tool_handler(server, tool, TIMEOUT)(args)
        finally:
            with contextlib.suppress(Exception):
                shutdown_mcp_servers()
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        data = raw
    if isinstance(data, dict) and data.get("error") and "result" not in data:
        message = str(data.get("error"))
        # Only a bare error is the service's own answer (MCP «isError»); anything richer comes from Hermes.
        if set(data) <= {"error", "success"} and not explain(message):
            raise UserError("La herramienta devolvió un error (texto del propio servicio, puede estar en inglés): " + message[:600])
        raise UserError(explain(message) or "Hermes no pudo completar la llamada a la herramienta.")
    if isinstance(data, dict) and isinstance(data.get("result"), str):
        text = data["result"]
    else:
        text = raw if isinstance(raw, str) else json.dumps(data, ensure_ascii=False, indent=1)
    return {"result": text[:LIMIT], "truncated": len(text) > LIMIT}


def main():
    request = json.loads(sys.stdin.read())
    installation = Path(os.environ["AGORA_HERMES_PATH"]).resolve()
    revision = subprocess.check_output(["/usr/bin/git", "-C", str(installation), "rev-parse", "HEAD"], text=True).strip()
    if not (revision == EXPECTED_COMMIT and not subprocess.check_output(["/usr/bin/git", "-C", str(installation), "status", "--porcelain", "--untracked-files=no"], text=True).strip()):
        raise UserError("La versión de Hermes instalada no está verificada para AgoraOne.")
    sys.path.insert(0, str(installation))
    isolate_environment()
    return call(request)


if __name__ == "__main__":
    out = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        try:
            result = {"ok": True, **main()}
        except UserError as error:
            result = {"ok": False, "error": str(error)}
        except Exception:
            import traceback
            traceback.print_exc()  # stderr only: the server discards it, never shown to the user
            result = {"ok": False, "error": "Hermes no pudo completar la llamada."}
    print(json.dumps(result, ensure_ascii=False), file=out)
