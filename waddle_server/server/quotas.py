"""Per-org ingest metering: a fixed-window requests-per-minute counter,
in-process (the factory ratelimit shape). Overrides come from ``org_limits``;
absent row = settings defaults."""

from __future__ import annotations

import time
from uuid import UUID

from waddle_server.errors import QuotaExceededError

_windows: dict[UUID, tuple[int, int]] = {}  # org -> (minute, count)


def check_rpm(org_id: UUID, org_slug: str, limit: int) -> None:
    minute = int(time.time() // 60)
    window_minute, count = _windows.get(org_id, (minute, 0))
    if window_minute != minute:
        count = 0
    if count >= limit:
        raise QuotaExceededError(org_slug, f"ingest rate limit of {limit}/min exceeded")
    _windows[org_id] = (minute, count + 1)


def reset() -> None:
    """Test hook."""
    _windows.clear()
