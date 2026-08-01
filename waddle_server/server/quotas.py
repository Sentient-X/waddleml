"""Per-org ingest metering: a fixed-window requests-per-minute counter,
in-process (the factory ratelimit shape). Overrides come from ``org_limits``;
absent row = settings defaults."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from math import ceil
from threading import Lock
from uuid import UUID

from waddle_server.errors import QuotaExceededError

_windows: dict[UUID, deque[float]] = defaultdict(deque)
_windows_lock = Lock()


def check_rpm(org_id: UUID, org_slug: str, limit: int) -> None:
    now = time.monotonic()
    with _windows_lock:
        window = _windows[org_id]
        while window and now - window[0] >= 60:
            window.popleft()
        if len(window) >= limit:
            retry_after_s = max(1, ceil(60 - (now - window[0])))
            raise QuotaExceededError(
                org_slug,
                f"ingest rate limit of {limit}/min exceeded",
                retry_after_s,
            )
        window.append(now)


def reset() -> None:
    """Test hook."""
    with _windows_lock:
        _windows.clear()
