"""Drafting a reply with Claude for the user to read, change and confirm: the user's Claude Code session first, then the
API key. Shared by the mail and WhatsApp replies; it only writes text and never sends anything."""

import asyncio
from contextlib import aclosing

from .engines import AnthropicApiEngine, ClaudeCodeEngine, Turn, usable
from .settings import Settings


class DraftError(RuntimeError):
    pass


def claude_drafter(settings: Settings, secrets):
    """`write(system, text)` with the user's Claude Code session, then the API key; DraftError when neither
    answers."""
    def write(system: str, text: str) -> str:
        engines = [e for e in usable([ClaudeCodeEngine(settings.data_dir / "claude-code"), AnthropicApiEngine(secrets)])
                   if e.name in ("claude-code", "anthropic-api")]
        error: Exception | None = None
        for engine in engines:
            async def run(engine=engine):
                parts = []
                async with aclosing(engine.stream(Turn(system, [{"role": "user", "content": text}], "sonnet"))) as stream:
                    async for piece in stream:
                        if piece:
                            parts.append(piece)
                return "".join(parts)
            try:
                return asyncio.run(run())
            except Exception as failure:  # noqa: BLE001 - try the next engine
                error = failure
        raise DraftError("No hay ningún motor de Claude disponible para redactar." if error is None else "El asistente no ha podido redactar ahora.")
    return write
