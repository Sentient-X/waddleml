"""WaddleML — lightweight ML experiment tracker. Works anywhere, git optional."""

from ._api import init, log, finish, log_artifact, log_param, log_tag
from ._run import Run
from ._db import WaddleDB
from ._types import ResearchGoal, ResearchTrial, ResearchTrialError, WorkerInfo

__all__ = [
    "init",
    "log",
    "finish",
    "log_artifact",
    "log_param",
    "log_tag",
    "Run",
    "WaddleDB",
    "WorkerInfo",
    "ResearchGoal",
    "ResearchTrial",
    "ResearchTrialError",
]
