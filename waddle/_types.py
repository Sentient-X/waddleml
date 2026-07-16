"""Shared dataclasses."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class WorkerInfo:
    """Stable identity for one process participating in a distributed run."""

    rank: int = 0
    local_rank: int = 0
    world_size: int = 1
    node_id: str = "localhost"
    attempt: int = 0

    def __post_init__(self) -> None:
        if self.world_size < 1:
            raise ValueError("world_size must be positive")
        if not 0 <= self.rank < self.world_size:
            raise ValueError("rank must be within world_size")
        if self.local_rank < 0 or self.attempt < 0:
            raise ValueError("local_rank and attempt must be non-negative")


@dataclass
class RepoInfo:
    id: str
    name: str
    path: str
    origin_url: Optional[str]
    default_branch: str
