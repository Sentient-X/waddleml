"""WaddleML — lightweight ML experiment tracker. Works anywhere, git optional."""

from ._api import (
    init,
    log,
    finish,
    log_artifact,
    log_line,
    log_param,
    log_tag,
    use_artifact,
)
from ._run import Run
from ._db import WaddleDB
from ._types import (
    ArtifactRelation,
    ResearchDecision,
    ResearchGoal,
    ResearchOutcome,
    ResearchTrial,
    ResearchTrialError,
    RunType,
    RunTypeError,
    WorkerInfo,
)

__all__ = [
    "init",
    "log",
    "finish",
    "log_artifact",
    "use_artifact",
    "log_line",
    "log_param",
    "log_tag",
    "Run",
    "WaddleDB",
    "WorkerInfo",
    "ArtifactRelation",
    "ResearchGoal",
    "ResearchDecision",
    "ResearchOutcome",
    "ResearchTrial",
    "ResearchTrialError",
    "RunType",
    "RunTypeError",
]
