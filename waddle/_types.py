"""Shared dataclasses."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class ResearchGoal(str, Enum):
    """Direction of one immutable autoresearch objective."""

    MINIMIZE = "minimize"
    MAXIMIZE = "maximize"


class ResearchTrialError(ValueError):
    """A research trial record violates Waddle's campaign contract."""


@dataclass(frozen=True)
class ResearchTrial:
    """Typed facts that make an ordinary Waddle run one candidate in a tree."""

    campaign: str
    trial_index: int
    objective_name: str
    goal: ResearchGoal
    hypothesis: str
    parent_run_id: Optional[str] = None  # none-ok: the campaign root has no parent

    def __post_init__(self) -> None:
        if not self.campaign.strip():
            raise ResearchTrialError("campaign must not be empty")
        if self.trial_index < 0:
            raise ResearchTrialError("trial_index must be non-negative")
        if not self.objective_name.strip():
            raise ResearchTrialError("objective_name must not be empty")
        if not self.hypothesis.strip():
            raise ResearchTrialError("hypothesis must not be empty")
        if self.parent_run_id is not None and not self.parent_run_id.strip():
            raise ResearchTrialError("parent_run_id must not be empty when present")


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
