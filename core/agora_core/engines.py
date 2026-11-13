"""Engines that write the assistant's answers, in order of preference:

1. Claude through the Agent SDK with the user's own local Claude Code session (no API key in its
   environment, so it never bills the API by surprise). AgoraOne never asks for, stores or relays
   claude.ai credentials.
2. Claude through the Anthropic API with a key kept in the Keychain.
3. Any OpenAI-compatible provider (base URL, model and key in the Keychain), called directly.

All of them run outside this Mac: callers only give them what the `external` audience may see.
In this phase engines only write; they get no tools.
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

MODELS = {"sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5", "fable": "claude-fable-5-2"}
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


class Engine(Protocol):
    name: str

    def available(self) -> bool: ...
    def stream(self, turn: Turn) -> AsyncIterator[str]: ...


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

        return ClaudeAgentOptions(
            system_prompt=turn.system, model=MODELS.get(turn.model, MODELS[DEFAULT_MODEL]),
            tools=[], allowed_tools=[], mcp_servers={}, strict_mcp_config=True, setting_sources=[],
            max_turns=1, cwd=str(self.workdir) if self.workdir else None,
            extra_args={"no-session-persistence": None},
        )

    async def stream(self, turn: Turn) -> AsyncIterator[str]:
        from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, query

        # The child inherits this process's environment, from which scrub_api_keys() removed the API
        # variables at startup: an empty value would not do (an empty base URL breaks the connection).
        options = self.options(turn)
        prompt = _transcript(turn.messages)
        workdir = self.workdir
        if workdir is not None:
            workdir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            async for message in query(prompt=prompt, options=options):
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock) and block.text:
                            yield block.text
                elif isinstance(message, ResultMessage) and message.is_error:
                    raise EngineError(f"Claude Code no pudo responder ({message.subtype}).")
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

    async def stream(self, turn: Turn) -> AsyncIterator[str]:
        import anthropic

        key = self.secrets.get(SECRET_ACCOUNTS["anthropic"])
        if not key:
            raise EngineError("Falta la clave de API de Anthropic.")
        try:
            async with anthropic.AsyncAnthropic(api_key=key, max_retries=1) as client, client.messages.stream(
                model=MODELS.get(turn.model, MODELS[DEFAULT_MODEL]), max_tokens=4096,
                system=turn.system, messages=turn.messages,
            ) as stream:
                async for text in stream.text_stream:
                    yield text
        except anthropic.APIError as error:
            raise EngineError(f"La API de Anthropic respondió con un error ({type(error).__name__}).") from error


class CompatibleEngine:
    """An OpenAI-compatible chat endpoint. Its base URL and model come from settings, its key from the Keychain."""

    name = "compatible"

    def __init__(self, secrets: Secrets, base_url: str | None, model: str | None):
        self.secrets, self.base_url, self.model = secrets, (base_url or "").rstrip("/"), model

    def available(self) -> bool:
        return bool(public_https(self.base_url) and self.model and self.secrets.get(SECRET_ACCOUNTS["compatible"]))

    async def stream(self, turn: Turn) -> AsyncIterator[str]:
        key = self.secrets.get(SECRET_ACCOUNTS["compatible"])
        if not self.available() or not key:
            raise EngineError("El proveedor compatible no está configurado.")
        if not resolves_public(self.base_url):
            raise EngineError("La dirección del proveedor apunta a este Mac o a una red privada.")
        body = {"model": self.model, "stream": True,
                "messages": [{"role": "system", "content": turn.system}, *turn.messages]}
        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=False, trust_env=False) as client:
                async with client.stream("POST", f"{self.base_url}/chat/completions", json=body,
                                         headers={"Authorization": f"Bearer {key}"}) as response:
                    if response.status_code != 200:
                        raise EngineError(f"El proveedor respondió {response.status_code}.")
                    async for line in response.aiter_lines():
                        if not line.startswith("data:") or line.strip() == "data: [DONE]":
                            continue
                        try:
                            delta = json.loads(line[5:])["choices"][0]["delta"].get("content")
                        except (ValueError, KeyError, IndexError, TypeError):
                            continue
                        if delta:
                            yield delta
        except httpx.HTTPError as error:
            raise EngineError(f"El proveedor no responde ({type(error).__name__}).") from error


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

