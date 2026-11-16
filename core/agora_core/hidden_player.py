"""YouTube in AgoraOne's hidden window (1.7): the videos whose owners do not allow the embed play in a window of the
desktop app that is never shown. The screen leaves its orders here and the desktop app collects them by asking and
waiting (it is the only one that reaches /internal); the window itself never talks to the core. The screen knows the
window is there while the desktop app keeps asking."""

import asyncio
import re
import time
from collections import deque

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
ACTIONS = {"play", "pause", "resume", "stop", "volume", "seek"}
SEEN_FOR = 40  # seconds without the desktop app asking: the hidden window is not there
WAIT = 25


def valid(command: dict) -> dict | None:
    """The order as the desktop app gets it, with only the fields it needs; None when it makes no sense."""
    action = command.get("action")
    if action not in ACTIONS:
        return None
    if action == "play":
        ident = command.get("id")
        return {"action": action, "id": ident} if isinstance(ident, str) and VIDEO_ID.match(ident) else None
    if action == "volume":
        level = command.get("volume")
        return {"action": action, "volume": int(level)} if isinstance(level, (int, float)) and 0 <= level <= 100 else None
    if action == "seek":
        at = command.get("seconds")
        return {"action": action, "seconds": float(at)} if isinstance(at, (int, float)) and 0 <= at <= 86400 else None
    return {"action": action}


class Relay:
    def __init__(self):
        self.seq = 0
        self.recent: deque[tuple[int, dict]] = deque(maxlen=20)
        self.seen = 0.0
        self.changed = asyncio.Event()

    def available(self) -> bool:
        return self.seen > 0 and time.monotonic() - self.seen < SEEN_FOR

    def push(self, command: dict) -> int:
        self.seq += 1
        self.recent.append((self.seq, command))
        changed, self.changed = self.changed, asyncio.Event()
        changed.set()
        return self.seq

    def after(self, seq: int) -> list[dict]:
        return [{"seq": n, **c} for n, c in self.recent if n > seq]

    async def next(self, seq: int, wait: float = WAIT) -> dict:
        """The orders after `seq`, waiting up to `wait` seconds for one. A desktop app that starts (seq < 0) only
        learns where the count is: an old order is never played again."""
        self.seen = time.monotonic()
        if seq > self.seq:  # the core started again (its count went back): follow it, without waiting
            return {"seq": self.seq, "commands": []}
        if seq >= 0 and not self.after(seq):
            changed = self.changed
            try:
                await asyncio.wait_for(changed.wait(), wait)
            except TimeoutError:
                pass
            self.seen = time.monotonic()
        return {"seq": self.seq, "commands": self.after(seq) if seq >= 0 else []}
