"""The server's typed vocabulary. Wire values are contracts: ``RunState`` is
byte-equal to the SDK's run status strings, ``WaddleRole`` to the audience roles
seeded in sx_authd's registry."""

from __future__ import annotations

from enum import StrEnum


class RunState(StrEnum):
    """Byte-equal to the SDK's ``runs.status`` vocabulary (waddle/_run.py)."""

    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    ABORTED = "aborted"


class RunType(StrEnum):
    """Stable intent of one run; byte-equal to the SDK's ``RunType``."""

    TRAINING = "training"
    EVALUATION = "evaluation"
    BENCHMARK = "benchmark"
    DATA = "data"
    AUTORESEARCH = "autoresearch"


class ResearchGoal(StrEnum):
    """Direction of one immutable autoresearch objective."""

    MINIMIZE = "minimize"
    MAXIMIZE = "maximize"


class ResearchDecision(StrEnum):
    """Controller-authored terminal decision for one research trial."""

    BASELINE = "baseline"
    KEEP = "keep"
    DISCARD = "discard"
    FAIL = "fail"
    INCONCLUSIVE = "inconclusive"


class LogLevel(StrEnum):
    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class ColumnType(StrEnum):
    """Coarse column types riding every SQL result (Evidence's evidenceType
    vocabulary): enough for formatting and axis inference, no more."""

    NUMBER = "number"
    STRING = "string"
    BOOLEAN = "boolean"
    DATE = "date"


class WaddleRole(StrEnum):
    """The waddle audience roles (sx_authd migration 0003). Authorization is
    org-granular: a role applies to the whole org's tracking data — scoped
    grants are deliberately not consulted here (no per-run ACLs exist)."""

    READER = "reader"
    WRITER = "writer"
    ADMIN = "admin"


_ROLE_RANK = {WaddleRole.READER: 0, WaddleRole.WRITER: 1, WaddleRole.ADMIN: 2}


def role_at_least(role: WaddleRole, required: WaddleRole) -> bool:
    return _ROLE_RANK[role] >= _ROLE_RANK[required]
