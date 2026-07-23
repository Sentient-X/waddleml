"""Thread-safe global run state and step counter."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ._run import Run

_lock = threading.Lock()
_active_run: Optional[Run] = None
_step_counter: int = 0


class NoActiveRunError(RuntimeError):
    """Raised when a write verb runs with no active run started by waddle.init()."""


def set_active_run(run: Optional[Run]) -> None:
    global _active_run, _step_counter
    with _lock:
        _active_run = run
        _step_counter = 0


def get_active_run() -> Optional[Run]:
    with _lock:
        return _active_run


def require_active_run() -> "Run":
    with _lock:
        if _active_run is None:
            raise NoActiveRunError("No active run. Call waddle.init() first.")
        return _active_run


def next_step() -> int:
    global _step_counter
    with _lock:
        s = _step_counter
        _step_counter += 1
        return s


def set_step(step: int) -> None:
    global _step_counter
    with _lock:
        _step_counter = step
