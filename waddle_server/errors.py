"""Typed error taxonomy. Boundary rejections raise these — never bare
ValueError — and the app maps each onto its stable HTTP status."""

from __future__ import annotations


class WaddleServerError(Exception):
    """Base for all served errors; ``code`` is the stable wire error code."""

    code = "waddle_error"


class RunNotFoundError(WaddleServerError):
    code = "run_not_found"

    def __init__(self, run_id: str) -> None:
        super().__init__(f"no run {run_id!r} in this organization")
        self.run_id = run_id


class BatchDigestMismatchError(WaddleServerError):
    """A batch id was replayed with different payload bytes — a client bug or
    corruption; never silently accepted."""

    code = "batch_digest_mismatch"

    def __init__(self, batch_id: str) -> None:
        super().__init__(f"batch {batch_id!r} was already ingested with different contents")
        self.batch_id = batch_id


class BatchLimitError(WaddleServerError):
    code = "batch_limit_exceeded"

    def __init__(self, detail: str) -> None:
        super().__init__(detail)


class QuotaExceededError(WaddleServerError):
    code = "quota_exceeded"

    def __init__(self, org_slug: str, detail: str) -> None:
        super().__init__(f"org {org_slug!r}: {detail}")
        self.org_slug = org_slug


class QueryLimitError(WaddleServerError):
    code = "query_limit_exceeded"

    def __init__(self, detail: str) -> None:
        super().__init__(detail)


class SqlSandboxError(WaddleServerError):
    """The SQL sandbox refused or failed a query; ``kind`` is the taxonomy
    (timeout / query_failed / crashed)."""

    code = "sql_sandbox_error"

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind


class ReportCompileError(WaddleServerError):
    """A report body was rejected by the compiler; ``kind`` is the taxonomy
    (bad_frontmatter / bad_query / duplicate_query / unknown_reference /
    cycle / unknown_component / bad_component)."""

    code = "report_compile_error"

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind


class ReportNotFoundError(WaddleServerError):
    code = "report_not_found"

    def __init__(self, name: str) -> None:
        super().__init__(f"no report {name!r} in this organization")
        self.name = name


class MissingParamsError(WaddleServerError):
    """A render was attempted without values for every ``${params.x}`` the
    report requires."""

    code = "missing_params"

    def __init__(self, missing: list[str]) -> None:
        super().__init__(f"missing report params: {', '.join(missing)}")
        self.missing = missing


class DatasetNameError(WaddleServerError):
    """A dataset upload used a reserved or malformed dataset name."""

    code = "invalid_dataset"

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
