"""Background classification of WhatsApp conversations, with the same round as mail (`mail_summarizer`): what may
not leave this Mac is settled here every round, one small batch at most goes to Claude Haiku (the user's Claude
Code session or else the Anthropic API, as data and without tools), at most so many calls per hour, and a model
failure only pauses it."""

import threading
from collections.abc import Callable

from . import chat_inbox
from .engines import Engine
from .mail_summarizer import Budget, Reader, SummaryHealth, summary_worker
from .settings import Settings

CHAT = Reader(chat_inbox.unread, chat_inbox.plan, chat_inbox.store, lambda entry: entry["chat"], chat_inbox.SYSTEM,
              chat_inbox.prompt, chat_inbox.parse, chat_inbox.BATCH, "WhatsApp", "WhatsApp")


def chat_summary_worker(settings: Settings, make_engines: Callable[[], list[Engine]], stop: threading.Event, health: SummaryHealth,
                        budget: Budget | None = None, shadow=None) -> None:
    summary_worker(settings, make_engines, stop, health, reader=CHAT, budget=budget, shadow=shadow)
