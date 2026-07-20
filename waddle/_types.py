"""Shared dataclasses."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Tuple


class ResearchGoal(str, Enum):
    """Direction of one immutable autoresearch objective."""

    MINIMIZE = "minimize"
    MAXIMIZE = "maximize"


class ResearchDecision(str, Enum):
    """Controller-authored terminal decision for one research trial."""

    BASELINE = "baseline"
    KEEP = "keep"
    DISCARD = "discard"
    FAIL = "fail"
    INCONCLUSIVE = "inconclusive"


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
    session_name: Optional[str] = (
        None  # none-ok: legacy trials predate research sessions
    )
    subject_run_id: Optional[str] = (
        None  # none-ok: only evaluation trials target another run
    )
    rationale: Optional[str] = (
        None  # none-ok: legacy trials predate structured proposal context
    )
    expected_outcome: Optional[str] = (
        None  # none-ok: legacy trials predate structured proposal context
    )
    falsification_criteria: Optional[str] = (
        None  # none-ok: legacy trials predate structured proposal context
    )

    def __post_init__(self) -> None:
        if not self.campaign.strip():
            raise ResearchTrialError("campaign must not be empty")
        if self.trial_index < 0:
            raise ResearchTrialError("trial_index must be non-negative")
        if not self.objective_name.strip():
            raise ResearchTrialError("objective_name must not be empty")
        if not self.hypothesis.strip():
            raise ResearchTrialError("hypothesis must not be empty")
        if self.session_name is not None and not self.session_name.strip():
            raise ResearchTrialError("session_name must not be empty when present")
        if self.parent_run_id is not None and not self.parent_run_id.strip():
            raise ResearchTrialError("parent_run_id must not be empty when present")
        if self.subject_run_id is not None and not self.subject_run_id.strip():
            raise ResearchTrialError("subject_run_id must not be empty when present")
        for name, value in (
            ("rationale", self.rationale),
            ("expected_outcome", self.expected_outcome),
            ("falsification_criteria", self.falsification_criteria),
        ):
            if value is not None and not value.strip():
                raise ResearchTrialError(f"{name} must not be empty when present")


@dataclass(frozen=True)
class ResearchOutcome:
    """Evidence and conclusion written by the controller after evaluation."""

    decision: ResearchDecision
    evidence: str
    conclusion: str
    failed_gates: Tuple[str, ...] = ()
    next_step: Optional[str] = (
        None  # none-ok: a terminal campaign or dead end has no next action
    )

    def __post_init__(self) -> None:
        if not self.evidence.strip():
            raise ResearchTrialError("research outcome evidence must not be empty")
        if not self.conclusion.strip():
            raise ResearchTrialError("research outcome conclusion must not be empty")
        if any(not gate.strip() for gate in self.failed_gates):
            raise ResearchTrialError(
                "research outcome failed_gates must not contain blanks"
            )
        if self.next_step is not None and not self.next_step.strip():
            raise ResearchTrialError(
                "research outcome next_step must not be empty when present"
            )


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
