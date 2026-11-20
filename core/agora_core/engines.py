"""Engines that write the assistant's answers, in order of preference:

1. Claude through the Agent SDK with the user's own local Claude Code session (no API key in its
   environment, so it never bills the API by surprise). AgoraOne never asks for, stores or relays
   claude.ai credentials.
2. Claude through the Anthropic API with a key kept in the Keychain.
3. Any OpenAI-compatible provider (base URL, model and key in the Keychain), called directly.

All of them run outside this Mac: callers only give them what the `external` audience may see.
Their only tools are the brain's read-only ones (brain_tools.Toolbox), never the user's own tools or MCP
servers. A stream yields text, and None after each tool round so the caller can report what was done.
"""

import ipaddress
import json
import shutil
import socket
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlparse

import httpx

MODELS = {"sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5", "fable": "claude-fable-5-2", "haiku": "claude-haiku-5-5"}
DEFAULT_MODEL = "sonnet"
SECRET_ACCOUNTS = {"anthropic": "anthropic-api-key", "compatible": "openai-compatible-key"}
_API_KEYS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL")


class EngineError(RuntimeError):
    pass


@dataclass(frozen=True)
class Turn:
    system: str
    messages: list[dict]  # [{"role": "user"|"assistant", "content": str}]
    model: str  # key of MODELS for Claude engines; the provider's model name for compatible ones
    toolbox: object | None = None  # brain_tools.Toolbox: read-only brain tools for this answer
    tools: tuple[str, ...] | None = None  # only these of the brain's tools (a research turn); None: the usual ones
    searches: int = 0  # web searches allowed (a research turn, on Anthropic's servers); 0: none


class Engine(Protocol):
    name: str

    def available(self) -> bool: ...
    def stream(self, turn: Turn) -> AsyncIterator[str | None]: ...


class Secrets(Protocol):
    def get(self, account: str) -> str | None: ...


class ClaudeCodeEngine:
    """The local Claude Code session through the Agent SDK. Its environment is scrubbed of API keys.

    It only writes: no tools at all, no MCP servers (not even the user's own), an empty working folder,
    and no session saved to disk (the conversation already lives in the brain)."""

    name = "claude-code"

    def __init__(self, workdir=None):
        self.workdir = workdir

    def available(self) -> bool:
        return bool(shutil.which("claude")) or self._bundled()

    @staticmethod
    def _bundled() -> bool:
        try:
            import claude_agent_sdk  # noqa: F401
        except ImportError:
            return False
        return True

    def options(self, turn: Turn):
        from claude_agent_sdk import ClaudeAgentOptions

        servers, allowed, turns, builtin = {}, [], 1, []
        if turn.toolbox is not None:
            # Only the brain's tools, served in this process: none of the user's MCP servers.
            servers = {"cerebro": _sdk_server(turn.toolbox, turn.tools)}
            allowed = [f"mcp__cerebro__{spec['name']}" for spec in _specs(names=turn.tools)]
            turns = turn.toolbox.max_calls + 2
        if turn.searches:
            # A research turn searches on Anthropic's servers; pages are read by the core (leer_pagina), never by
            # Claude Code's WebFetch, which would fetch from this Mac without the core's checks.
            builtin, allowed, turns = ["WebSearch"], [*allowed, "WebSearch"], turns + turn.searches
        return ClaudeAgentOptions(
            system_prompt=turn.system, model=MODELS.get(turn.model, MODELS[DEFAULT_MODEL]),
            tools=builtin, allowed_tools=allowed, mcp_servers=servers, strict_mcp_config=True, setting_sources=[],
            max_turns=turns, cwd=str(self.workdir) if self.workdir else None,
            extra_args={"no-session-persistence": None},
            # Only what is on this computer counts: the account's claude.ai connectors (Gmail, Drive…) may
            # belong to whoever else shares the account, so they are never loaded (user's decision, 14/11/2026).
            env={"ENABLE_CLAUDEAI_MCP_SERVERS": "false"},
        )

    async def stream(self, turn: Turn) -> AsyncIterator[str | None]:
        from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage, query

        from .research import remember

        # The child inherits this process's environment, from which scrub_api_keys() removed the API
        # variables at startup: an empty value would not do (an empty base URL breaks the connection).
        options = self.options(turn)
        prompt = _transcript(turn.messages)
        workdir = self.workdir
        if workdir is not None:
            workdir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            # Text written before a tool call is the model thinking aloud, not the answer: it is held and
            # dropped when a tool call follows, unless the call only proposes something (the answer comes first).
            held: list[str] = []
            searches: set[str] = set()  # ids of WebSearch calls, whose results say which pages may be read
            async for message in query(prompt=prompt, options=options):
                if isinstance(message, UserMessage) and searches and not isinstance(message.content, str):
                    for block in message.content:
                        if isinstance(block, ToolResultBlock) and block.tool_use_id in searches:
                            remember(turn.toolbox, json.dumps(block.content, ensure_ascii=False, default=str))
                    continue
                if isinstance(message, AssistantMessage):
                    calls = [block for block in message.content if isinstance(block, ToolUseBlock)]
                    if calls:
                        searches |= {block.id for block in calls if block.name == "WebSearch"}
                        proposing = turn.tools is not None and all(block.name.startswith("mcp__cerebro__proponer_") for block in calls)
                        texts = [block.text for block in message.content if isinstance(block, TextBlock) and block.text]
                        held = [*held, *texts] if proposing else []
                        yield None
                        continue
                    for block in message.content:
                        if isinstance(block, TextBlock) and block.text:
                            if turn.toolbox is None:
                                yield block.text
                            else:
                                held.append(block.text)
                elif isinstance(message, ResultMessage):
                    if message.is_error:
                        raise EngineError(f"Claude Code no pudo responder ({message.subtype}).")
                    for text in held:
                        yield text
                    held = []
        except EngineError:
            raise
        except Exception as error:  # the SDK raises its own types for a missing login, a crash...
            raise EngineError(f"Claude Code no está disponible ({type(error).__name__}).") from error


class AnthropicApiEngine:
    name = "anthropic-api"

    def __init__(self, secrets: Secrets):
        self.secrets = secrets

    def available(self) -> bool:
        return bool(self.secrets.get(SECRET_ACCOUNTS["anthropic"]))

    async def stream(self, turn: Turn) -> AsyncIterator[str | None]:
        import anthropic

        key = self.secrets.get(SECRET_ACCOUNTS["anthropic"])
        if not key:
            raise EngineError("Falta la clave de API de Anthropic.")
        toolbox = turn.toolbox
        tools = [{"name": s["name"], "description": s["description"], "input_schema": s["schema"]} for s in _specs(names=turn.tools)] if toolbox else []
        if turn.searches:  # searched on Anthropic's servers, at most this many times in the whole answer
            tools.append({"type": "web_search_20260318", "name": "web_search", "max_uses": turn.searches})
        messages = list(turn.messages)
        container = None
        try:
            async with anthropic.AsyncAnthropic(api_key=key, max_retries=1) as client:
                for _ in range((toolbox.max_calls + 1 + turn.searches) if toolbox else 1):
                    async with client.messages.stream(
                        model=MODELS.get(turn.model, MODELS[DEFAULT_MODEL]), max_tokens=8192 if turn.searches else 4096,
                        system=turn.system, messages=messages, **({"tools": tools} if tools else {}),
                        **({"container": container} if container else {}),
                    ) as stream:
                        held = []  # a research turn keeps only the last round's text: the rest is the model searching aloud
                        async for text in stream.text_stream:
                            if turn.searches:
                                held.append(text)
                            else:
                                yield text
                        final = await stream.get_final_message()
                    container = getattr(getattr(final, "container", None), "id", None) or container
                    if turn.searches:
                        _remember_results(toolbox, final.content)
                    if final.stop_reason == "pause_turn":  # a long web search paused the turn: it goes on from there
                        messages += [{"role": "assistant", "content": final.content}]
                        yield None
                        continue
                    if final.stop_reason != "tool_use":
                        for text in held:
                            yield text
                        return
                    results = [{"type": "tool_result", "tool_use_id": block.id, "content": await toolbox.call(block.name, block.input)}
                               for block in final.content if block.type == "tool_use"]
                    messages += [{"role": "assistant", "content": final.content}, {"role": "user", "content": results}]
                    yield None
        except anthropic.APIError as error:
            raise EngineError(f"La API de Anthropic respondió con un error ({type(error).__name__}).") from error


def _remember_results(toolbox, content) -> None:
    """The addresses of the API's web_search results: the only pages a research turn may read."""
    from .research import remember

    for block in content:
        if getattr(block, "type", "") == "web_search_tool_result" and isinstance(getattr(block, "content", None), list):
            remember(toolbox, " ".join(str(getattr(item, "url", "")) for item in block.content))


class CompatibleEngine:
    """An OpenAI-compatible chat endpoint. Its base URL and model come from settings, its key from the Keychain."""

    name = "compatible"

    def __init__(self, secrets: Secrets, base_url: str | None, model: str | None):
        self.secrets, self.base_url, self.model = secrets, (base_url or "").rstrip("/"), model

    def available(self) -> bool:
        return bool(public_https(self.base_url) and self.model and self.secrets.get(SECRET_ACCOUNTS["compatible"]))

    async def stream(self, turn: Turn) -> AsyncIterator[str | None]:
        key = self.secrets.get(SECRET_ACCOUNTS["compatible"])
        if not self.available() or not key:
            raise EngineError("El proveedor compatible no está configurado.")
        if not resolves_public(self.base_url):
            raise EngineError("La dirección del proveedor apunta a este Mac o a una red privada.")
        toolbox = turn.toolbox
        if toolbox is not None:
            toolbox.mail = False
        tools = [{"type": "function", "function": {"name": s["name"], "description": s["description"], "parameters": s["schema"]}}
                 for s in _specs(mail=False, names=turn.tools)] if toolbox else []
        messages = [{"role": "system", "content": turn.system}, *turn.messages]
        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=False, trust_env=False) as client:
                for _ in range((toolbox.max_calls + 1) if toolbox else 1):
                    body = {"model": self.model, "stream": True, "messages": messages, **({"tools": tools} if tools else {})}
                    calls: dict[int, dict] = {}
                    async with client.stream("POST", f"{self.base_url}/chat/completions", json=body,
                                             headers={"Authorization": f"Bearer {key}"}) as response:
                        if response.status_code != 200:
                            raise EngineError(f"El proveedor respondió {response.status_code}.")
                        async for line in response.aiter_lines():
                            if not line.startswith("data:") or line.strip() == "data: [DONE]":
                                continue
                            try:
                                delta = json.loads(line[5:])["choices"][0]["delta"]
                            except (ValueError, KeyError, IndexError, TypeError):
                                continue
                            for part in delta.get("tool_calls") or []:
                                call = calls.setdefault(part.get("index", 0), {"id": "", "name": "", "arguments": ""})
                                call["id"] = part.get("id") or call["id"]
                                function = part.get("function") or {}
                                call["name"] += function.get("name") or ""
                                call["arguments"] += function.get("arguments") or ""
                            if delta.get("content"):
                                yield delta["content"]
                    if not calls:
                        return
                    ordered = [calls[i] for i in sorted(calls)]
                    messages.append({"role": "assistant", "content": None, "tool_calls": [
                        {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}} for c in ordered]})
                    for c in ordered:
                        try:
                            args = json.loads(c["arguments"] or "{}")
                        except ValueError:
                            args = {}
                        messages.append({"role": "tool", "tool_call_id": c["id"], "content": await toolbox.call(c["name"], args if isinstance(args, dict) else {})})
                    yield None
        except httpx.HTTPError as error:
            raise EngineError(f"El proveedor no responde ({type(error).__name__}).") from error


PRIVATE_TOOLS = {"consultar_bandeja", "consultar_clientes", "consultar_agenda", "resumen_del_dia", "consultar_trabajos", "proponer_regla", "proponer_evento", "proponer_presupuesto", "proponer_limpieza",
                 "consultar_reuniones", "leer_reunion", "proponer_issue", "proponer_encargo_orca",
                 "proponer_respuesta_whatsapp", "consultar_crmdev", "proponer_cambio_crmdev"}  # mail, WhatsApp, clients, calendar, meetings, Orca and CRMDev: Claude only


HIDDEN_TOOLS: set[str] = set()  # tools of the modules turned off in Settings (modules.apply keeps it)


def _specs(mail: bool = True, names: tuple[str, ...] | None = None) -> list[dict]:
    from .brain_tools import SPECS
    from .research import ONLY_HERE

    if names is not None:  # a research turn: exactly these, never a private one
        return [spec for spec in SPECS if spec["name"] in names and spec["name"] not in PRIVATE_TOOLS and spec["name"] not in HIDDEN_TOOLS]
    shown = [spec for spec in SPECS if spec["name"] not in HIDDEN_TOOLS and spec["name"] not in ONLY_HERE]
    if not mail:  # normal mail is read by Claude only (plan of 1.1, 14/11/2026), never by the compatible provider
        return [spec for spec in shown if spec["name"] not in PRIVATE_TOOLS]
    return shown


def _sdk_server(toolbox, names: tuple[str, ...] | None = None):
    """The brain's tools as an in-process MCP server for the Agent SDK."""
    from claude_agent_sdk import create_sdk_mcp_server, tool

    def make(spec):
        async def handler(args):
            return {"content": [{"type": "text", "text": await toolbox.call(spec["name"], args)}]}
        return tool(spec["name"], spec["description"], spec["schema"])(handler)
    return create_sdk_mcp_server("cerebro", tools=[make(spec) for spec in _specs(names=names)])


def scrub_api_keys(environ=None) -> None:
    """Removes the API variables so the local Claude Code session is used, never an API key by surprise."""
    import os

    environ = os.environ if environ is None else environ
    for name in _API_KEYS:
        environ.pop(name, None)


def _transcript(messages: list[dict]) -> str:
    """The SDK takes one prompt: earlier turns go in as a labelled transcript, the last message last."""
    if len(messages) == 1:
        return messages[0]["content"]
    earlier = "\n\n".join(f"[{m['role']}]\n{m['content']}" for m in messages[:-1])
    return f"<conversacion_previa>\n{earlier}\n</conversacion_previa>\n\n{messages[-1]['content']}"


def public_https(url: str | None) -> bool:
    """An https address whose host is not this Mac nor a private network, judging by its name or literal IP."""
    parsed = urlparse(url or "")
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host or host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return "." in host


def resolves_public(url: str) -> bool:
    """Checked again right before sending: every address the name resolves to must be public."""
    host = urlparse(url).hostname or ""
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)}
    except OSError:
        return False
    return bool(addresses) and all(ipaddress.ip_address(a.split("%")[0]).is_global for a in addresses)


def usable(engines: list[Engine], preferred: str | None = None) -> list[Engine]:
    """Usable engines, the preferred one first."""
    return [e for e in sorted(engines, key=lambda e: e.name != preferred) if e.available()]


def choose(engines: list[Engine], preferred: str | None = None) -> Engine:
    """The preferred engine if it is usable, otherwise the first usable one in order."""
    for engine in usable(engines, preferred):
        return engine
    raise EngineError(
        "No hay ningún motor disponible: inicia sesión en Claude Code, añade una clave de API de Anthropic "
        "o configura un proveedor compatible en Ajustes."
    )



async def ask_with_image(engine, system: str, text: str, jpeg: bytes, model: str = "haiku") -> str:
    """One question about one image (an invoice photo), with no tools: through the Claude Code session or the
    Anthropic API. The image goes as data, like any text."""
    import base64

    data = base64.b64encode(jpeg).decode()
    content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}}, {"type": "text", "text": text}]
    if engine.name == "anthropic-api":
        import anthropic

        key = engine.secrets.get(SECRET_ACCOUNTS["anthropic"])
        async with anthropic.AsyncAnthropic(api_key=key, max_retries=1) as client:
            answer = await client.messages.create(model=MODELS[model], max_tokens=1500, system=system, messages=[{"role": "user", "content": content}])
        return "".join(getattr(block, "text", "") for block in answer.content)
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, query

    if engine.workdir is not None:
        engine.workdir.mkdir(parents=True, exist_ok=True, mode=0o700)
    options = engine.options(Turn(system, [], model))

    async def messages():
        yield {"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None, "session_id": "agoraone"}
    parts = []
    async for message in query(prompt=messages(), options=options):
        if isinstance(message, AssistantMessage):
            parts += [block.text for block in message.content if isinstance(block, TextBlock) and block.text]
        elif isinstance(message, ResultMessage) and message.is_error:
            raise EngineError(f"Claude Code no pudo responder ({message.subtype}).")
    return "".join(parts)
