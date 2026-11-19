"""The part of a confirmed change that is the same for every connector: the change the user reviewed is kept under a
single-use token, and «confirm» sends exactly that, once.

- `preview(change, owner)` keeps the change (with a fingerprint of the connection it was checked against) and
  answers its token. Tokens expire after `seconds`, and at most `limit` are kept.
- `confirm(token, send)` reserves the token before anything is awaited, so two presses at once never send twice, and
  never sends a change of the same thing (`change.target`) while another one is under way. A token already sent
  answers its result again with `repeated`; one still sending, or whose fate is unknown, is refused.

What each change is, how it is checked and how it is sent is each connector's (`central_write`, `crmdev_write`)."""

import secrets as random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar


class ChangeError(ValueError):
    """A change that cannot be asked (a field not allowed, a value out of range): 422, the service is not asked."""


class Targeted(Protocol):
    target: str  # what it changes («tarea:<id>»): two changes of the same thing are never sent at once


C = TypeVar("C", bound=Targeted)


@dataclass(frozen=True)
class Sentences:
    """What the user reads when a confirmation is refused, in the words of each connector."""
    expired: str
    sending: str
    unknown: str
    busy_target: str


class Refused(Exception):
    """A confirmation that is not sent: its HTTP status, its `status` for the screen and its sentence."""

    def __init__(self, status: int, kind: str, message: str):
        super().__init__(message)
        self.status = status
        self.kind = kind


@dataclass
class Pending(Generic[C]):
    change: C
    at: float
    owner: str  # the connection (address and key) it was previewed against: sent only there
    state: str = "ready"  # ready, sending, done or unknown
    result: dict | None = None


def _now() -> float:
    return time.time()


class PendingChanges(Generic[C]):
    def __init__(self, sentences: Sentences, seconds: int = 900, limit: int = 200):
        self.sentences = sentences
        self.seconds = seconds
        self.limit = limit
        self._items: dict[str, Pending[C]] = {}
        self._busy: set[str] = set()

    def forget_old(self) -> None:
        oldest_kept = _now() - self.seconds
        for token in [t for t, p in self._items.items() if p.at < oldest_kept and p.state != "sending"]:
            self._items.pop(token, None)
        while len(self._items) > self.limit:
            oldest = next((t for t, p in self._items.items() if p.state != "sending"), None)
            if oldest is None:
                break
            self._items.pop(oldest)

    def preview(self, change: C, owner: str) -> str:
        self.forget_old()
        token = random.token_urlsafe(24)
        self._items[token] = Pending(change, _now(), owner)
        return token

    def drop(self, token: str) -> None:
        self._items.pop(token, None)

    async def confirm(self, token: str, send: Callable[[str, Pending[C]], Awaitable[Any]]) -> Any:
        """Sends the change of `token` once with `send`, which sets the entry's state (`done` with its result, `ready`
        to allow another press, `unknown`) or drops it; anything else it leaves «sending» is dropped afterwards."""
        # From here to the reservation nothing is awaited: two presses at once can never both pass.
        self.forget_old()
        entry = self._items.get(token)
        if entry is None:
            raise Refused(410, "expired", self.sentences.expired)
        if entry.state == "done":
            return {**(entry.result or {}), "repeated": True}
        if entry.state == "sending":
            raise Refused(409, "repeated", self.sentences.sending)
        if entry.state == "unknown":
            raise Refused(409, "unknown", self.sentences.unknown)
        target = entry.change.target
        if target in self._busy:
            raise Refused(409, "repeated", self.sentences.busy_target)
        entry.state = "sending"
        self._busy.add(target)
        try:
            return await send(token, entry)
        finally:
            self._busy.discard(target)
            if entry.state == "sending":  # an unexpected failure: the change is reviewed again
                self._items.pop(token, None)
