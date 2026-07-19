"""Wire models (pydantic is the OpenAPI source of truth — the console derives
its types from this schema via codegen)."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from waddle_server.model import ColumnType, LogLevel, RunState

RUN_ID_PATTERN = r"^[a-f0-9]{32}$"
REPORT_NAME_PATTERN = r"^[a-z0-9][a-z0-9-]{0,127}$"
DATASET_NAME_PATTERN = r"^[a-z][a-z0-9_]{0,63}$"


class HealthOut(BaseModel):
    ok: bool


class WorkerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rank: int = Field(ge=0)
    local_rank: int = Field(ge=0)
    world_size: int = Field(ge=1)
    node_id: str = Field(min_length=1, max_length=256)
    attempt: int = Field(ge=0)
    writer_id: UUID


class CreateRunIn(BaseModel):
    """Create-or-attach: rank 0 and rank>0 workers, first attempts and resumes
    all send the same shape."""

    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(pattern=RUN_ID_PATTERN)
    project: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=512)
    display_name: str | None = None
    group_name: str | None = None
    job_type: str | None = None
    config: dict[str, object] = Field(default_factory=dict)
    commit_sha: str | None = None
    started_at: datetime
    resume: bool = False
    worker: WorkerIn


class RunRef(BaseModel):
    run_id: str
    project: str
    org_slug: str
    url: str


class WorkerOut(BaseModel):
    rank: int
    local_rank: int
    world_size: int
    node_id: str
    attempt: int
    started_at: datetime


class RunOut(BaseModel):
    run_id: str
    project: str
    name: str
    display_name: str | None
    state: RunState
    group_name: str | None
    job_type: str | None
    config: dict[str, object]
    summary: dict[str, object]
    commit_sha: str | None
    created_at: datetime
    started_at: datetime
    finished_at: datetime | None
    heartbeat_at: datetime | None


class RunDetailOut(RunOut):
    workers: list[WorkerOut]


class ProjectOut(BaseModel):
    name: str
    created_at: datetime


class MetricPointIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=512)
    step: int
    ts: float  # unix seconds (the SDK's clock)
    value: float


class LogLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ts: float
    level: LogLevel = LogLevel.INFO
    source: str = Field(default="", max_length=256)
    message: str = Field(max_length=64 * 1024)


class BatchIn(BaseModel):
    """One idempotent ingest batch from one writer. The server hashes the
    decompressed request body: a replayed ``batch_id`` must be byte-identical
    (same digest → replay ack; different → 409)."""

    model_config = ConfigDict(extra="forbid")

    batch_id: UUID
    writer_id: UUID
    rank: int = Field(ge=0, default=0)
    node_id: str = Field(default="localhost", max_length=256)
    attempt: int = Field(ge=0, default=0)
    sequence_start: int = Field(ge=0)
    sequence_end: int = Field(ge=0)
    metrics: list[MetricPointIn] = Field(default_factory=list)
    logs: list[LogLineIn] = Field(default_factory=list)


class BatchAck(BaseModel):
    batch_id: UUID
    replayed: bool
    warnings: list[str]


class FinishRunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: RunState = RunState.COMPLETED
    summary: dict[str, object] = Field(default_factory=dict)


class MetricsQueryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_ids: list[str] = Field(min_length=1)
    metric_names: list[str] = Field(default_factory=list)
    step_min: int | None = None
    step_max: int | None = None
    max_points: int = Field(default=1500, ge=1)


class SeriesPointOut(BaseModel):
    step: int
    value: float
    value_min: float
    value_max: float
    ts: datetime


class MetricSeriesOut(BaseModel):
    run_id: str
    metric_name: str
    points: list[SeriesPointOut]


class LatestMetricOut(BaseModel):
    run_id: str
    metric_name: str
    value: float
    step: int
    ts: datetime


class LogLineOut(BaseModel):
    ts: datetime
    level: str
    source: str
    message: str


class ErrorOut(BaseModel):
    """The stable error envelope (FastAPI's ``detail`` carries it)."""

    code: str
    message: str


class ArtifactKind(StrEnum):
    MODEL = "model"
    DATASET = "dataset"
    MEDIA = "media"
    FILE = "file"


class UploadFileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    logical_path: str = Field(min_length=1, max_length=1024)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    size_bytes: int = Field(ge=0)
    media_type: str | None = None


class CreateUploadSessionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    files: list[UploadFileIn] = Field(min_length=1, max_length=1000)


class UploadTargetOut(BaseModel):
    logical_path: str
    sha256: str
    url: str | None  # None = the org already holds this blob (dedup); skip upload


class UploadSessionOut(BaseModel):
    session_id: UUID
    expires_at: datetime
    targets: list[UploadTargetOut]


class CommitArtifactIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    collection: str = Field(min_length=1, max_length=512)
    project: str = Field(min_length=1, max_length=256)
    kind: ArtifactKind = ArtifactKind.FILE
    metadata: dict[str, object] = Field(default_factory=dict)
    run_id: str | None = Field(default=None, pattern=RUN_ID_PATTERN)
    relation: str = Field(default="output", pattern="^(input|output)$")


class ArtifactFileOut(BaseModel):
    logical_path: str
    sha256: str
    size_bytes: int
    media_type: str | None
    download_url: str


class ArtifactVersionOut(BaseModel):
    id: UUID
    collection: str
    version: int
    digest: str
    metadata: dict[str, object]
    created_by_run_id: str | None
    created_at: datetime
    files: list[ArtifactFileOut]


class AliasIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alias: str = Field(min_length=1, max_length=256)


class RunLineageOut(BaseModel):
    run_id: str
    relation: str
    collection: str
    version: int
    artifact_id: UUID


class SqlQueryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sql: str = Field(min_length=1, max_length=100_000)
    max_rows: int = Field(default=1000, ge=1, le=10_000)


class SqlResultOut(BaseModel):
    columns: list[str]
    column_types: list[ColumnType]
    rows: list[list[object]]
    truncated: bool


# ── reports as code ──────────────────────────────────────────────────────────


class ReportSummaryOut(BaseModel):
    """The stable identity is ``id`` (the URL/API key); ``name`` is a
    renameable per-org slug."""

    id: UUID
    name: str
    version: int
    title: str | None
    description: str | None
    updated_by: str | None
    updated_at: datetime


class ReportOut(ReportSummaryOut):
    body: str
    queries: list[str]
    required_params: list[str]


class CreateReportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=REPORT_NAME_PATTERN)
    body: str = Field(min_length=1, max_length=200_000)


class UpdateReportIn(BaseModel):
    """A save: new body, optionally a rename. Every accepted save appends an
    immutable version."""

    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=200_000)
    name: str | None = Field(default=None, pattern=REPORT_NAME_PATTERN)


class ReportVersionOut(BaseModel):
    version: int
    name: str
    updated_by: str | None
    created_at: datetime


class ReportVersionDetailOut(ReportVersionOut):
    body: str


class RenderReportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    params: dict[str, str] = Field(default_factory=dict)
    max_rows: int = Field(default=1000, ge=1, le=10_000)


class PreviewReportIn(RenderReportIn):
    body: str = Field(min_length=1, max_length=200_000)


class RenderBlockOut(BaseModel):
    """One rendered page block. Markdown arrives with value/param expressions
    already resolved; components carry verbatim props — the console's
    component registry owns their interpretation."""

    kind: Literal["markdown", "component"]
    text: str | None = None
    component: str | None = None
    props: dict[str, str] = Field(default_factory=dict)
    query: str | None = None
    children: list["RenderBlockOut"] = Field(default_factory=list["RenderBlockOut"])


class RenderReportOut(BaseModel):
    name: str | None
    title: str | None
    description: str | None
    required_params: list[str]
    params: dict[str, str]
    blocks: list[RenderBlockOut]
    results: dict[str, SqlResultOut]
    query_errors: dict[str, str]


# ── the datasets door (producer uploads to the org Parquet substrate) ────────


class DatasetColumnIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=r"^[A-Za-z_]\w{0,63}$")
    type: ColumnType


class PutDatasetIn(BaseModel):
    """A full tabular snapshot, replacing the dataset's previous snapshot.
    Rows are scalars only; the server writes the Parquet."""

    model_config = ConfigDict(extra="forbid")

    columns: list[DatasetColumnIn] = Field(min_length=1, max_length=64)
    rows: list[list[str | int | float | bool | None]] = Field(max_length=100_000)


class DatasetOut(BaseModel):
    dataset: str
    rows: int


class DatasetInfoOut(BaseModel):
    dataset: str
    files: int
