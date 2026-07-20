"""The ClickHouse layer: idempotent DDL, typed inserts, and the org-scoped
query paths. All user-supplied values travel as server-side bound parameters —
metric names and ids are data, never interpolated identifiers.

Design notes (recorded deviations from the raw W&B-spec DDL):

- Decimation is query-time (``GROUP BY intDiv(step, w)`` over the raw table)
  rather than pre-materialized 1m/10m/1h rollup tables. At robotics-fleet scale
  a partition scan aggregates in milliseconds; rollup tables are the recorded
  scale-up path if measured latency ever demands them.
- Retried batch inserts are absorbed by MergeTree block deduplication
  (``non_replicated_deduplication_window`` in the table DDL): a replayed batch
  re-inserts byte-identical blocks, which ClickHouse drops.
- Every query runs under the readonly settings profile (execution time, memory,
  result rows) — per-query caps, not trust.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING
from uuid import UUID

import clickhouse_connect

from waddle_server.config import WaddleSettings

if TYPE_CHECKING:
    from clickhouse_connect.driver.asyncclient import AsyncClient

_DDL = [
    """
    CREATE TABLE IF NOT EXISTS metric_points (
        org_id          UUID,
        project_id      UUID,
        run_id          String,
        metric_name     LowCardinality(String),
        step            Int64,
        ts              DateTime64(6),
        value           Float64,
        rank            UInt16,
        node_id         LowCardinality(String),
        attempt         UInt16,
        writer_id       UUID,
        batch_id        UUID,
        sequence_number UInt64
    )
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(ts)
    ORDER BY (org_id, project_id, run_id, metric_name, step, ts)
    TTL toDateTime(ts) + INTERVAL {metric_ttl_days} DAY
    SETTINGS non_replicated_deduplication_window = 1000
    """,
    """
    CREATE TABLE IF NOT EXISTS log_events (
        org_id          UUID,
        project_id      UUID,
        run_id          String,
        ts              DateTime64(6),
        level           LowCardinality(String),
        source          LowCardinality(String),
        message         String,
        writer_id       UUID,
        batch_id        UUID,
        sequence_number UInt64
    )
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(ts)
    ORDER BY (org_id, project_id, run_id, ts)
    TTL toDateTime(ts) + INTERVAL {log_ttl_days} DAY
    SETTINGS non_replicated_deduplication_window = 1000
    """,
]

_METRIC_COLUMNS = [
    "org_id",
    "project_id",
    "run_id",
    "metric_name",
    "step",
    "ts",
    "value",
    "rank",
    "node_id",
    "attempt",
    "writer_id",
    "batch_id",
    "sequence_number",
]

_LOG_COLUMNS = [
    "org_id",
    "project_id",
    "run_id",
    "ts",
    "level",
    "source",
    "message",
    "writer_id",
    "batch_id",
    "sequence_number",
]


@dataclass(frozen=True, slots=True)
class SeriesPoint:
    run_id: str
    metric_name: str
    rank: int
    step: int
    value: float
    value_min: float
    value_max: float
    ts: datetime


@dataclass(frozen=True, slots=True)
class LatestMetric:
    run_id: str
    metric_name: str
    rank: int
    value: float
    step: int
    ts: datetime
    value_min: float
    value_max: float


@dataclass(frozen=True, slots=True)
class LogLine:
    run_id: str
    ts: datetime
    level: str
    source: str
    message: str


class MetricStore:
    """One async ClickHouse client per process, opened by the app lifespan."""

    def __init__(self, cfg: WaddleSettings) -> None:
        self._cfg = cfg
        self._client: AsyncClient | None = None
        self._query_settings = {
            "readonly": 1,
            "max_execution_time": cfg.ch_max_execution_time_s,
            "max_memory_usage": cfg.ch_max_memory_bytes,
            "max_result_rows": 500_000,
        }

    async def open(self) -> None:
        self._client = await clickhouse_connect.get_async_client(
            dsn=self._cfg.ch_url,
            username=self._cfg.ch_user,
            password=self._cfg.ch_password,
            database=self._cfg.ch_database,
        )
        for ddl in _DDL:
            await self._client.command(
                ddl.format(
                    metric_ttl_days=self._cfg.ch_metric_ttl_days,
                    log_ttl_days=self._cfg.ch_log_ttl_days,
                )
            )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None

    @property
    def client(self) -> AsyncClient:
        assert self._client is not None, "MetricStore used before lifespan open()"
        return self._client

    async def insert_metrics(self, rows: list[tuple[object, ...]]) -> None:
        if rows:
            await self.client.insert("metric_points", rows, column_names=_METRIC_COLUMNS)

    async def insert_logs(self, rows: list[tuple[object, ...]]) -> None:
        if rows:
            await self.client.insert("log_events", rows, column_names=_LOG_COLUMNS)

    async def series(
        self,
        org_id: UUID,
        *,
        run_ids: list[str],
        metric_names: list[str],
        step_min: int | None,
        step_max: int | None,
        max_points: int,
    ) -> list[SeriesPoint]:
        """Attempt-deduplicated, decimated series: per (run, metric, rank,
        step) the latest attempt wins; distinct ranks are distinct series
        (per-rank telemetry keeps its origin — one rank never poses as
        another); steps are bucketed so no series exceeds ``max_points``
        points, with bucket width shared across ranks so their series align."""
        conditions = ["org_id = {org:UUID}", "run_id IN {runs:Array(String)}"]
        params: dict[str, object] = {"org": str(org_id), "runs": run_ids}
        if metric_names:
            conditions.append("metric_name IN {metrics:Array(String)}")
            params["metrics"] = metric_names
        if step_min is not None:
            conditions.append("step >= {step_min:Int64}")
            params["step_min"] = step_min
        if step_max is not None:
            conditions.append("step <= {step_max:Int64}")
            params["step_max"] = step_max
        where = " AND ".join(conditions)

        span = await self.client.query(
            f"SELECT min(step), max(step) FROM metric_points WHERE {where}",
            parameters=params,
            settings=self._query_settings,
        )
        if not span.result_rows or span.result_rows[0][0] is None:
            return []
        lo, hi = int(span.result_rows[0][0]), int(span.result_rows[0][1])
        width = max(1, (hi - lo + 1) // max_points)
        params["w"] = width

        result = await self.client.query(
            f"""
            SELECT run_id, metric_name, rank,
                   intDiv(step, {{w:Int64}}) * {{w:Int64}} AS bucket_step,
                   avg(v) AS value, min(v) AS value_min, max(v) AS value_max,
                   max(latest_ts) AS ts
            FROM (
                SELECT run_id, metric_name, rank, step,
                       argMax(value, (attempt, ts)) AS v, max(ts) AS latest_ts
                FROM metric_points
                WHERE {where}
                GROUP BY run_id, metric_name, rank, step
            )
            GROUP BY run_id, metric_name, rank, bucket_step
            ORDER BY run_id, metric_name, rank, bucket_step
            """,
            parameters=params,
            settings=self._query_settings,
        )
        return [
            SeriesPoint(
                run_id=row[0],
                metric_name=row[1],
                rank=int(row[2]),
                step=int(row[3]),
                value=float(row[4]),
                value_min=float(row[5]),
                value_max=float(row[6]),
                ts=row[7],
            )
            for row in result.result_rows
        ]

    async def latest(self, org_id: UUID, *, run_ids: list[str]) -> list[LatestMetric]:
        """Per (run, metric, rank): the value at the last step plus the
        min/max over the whole attempt-deduplicated stream (per step the
        latest attempt wins, same law as ``series`` — so a resume's rewritten
        early steps can neither pose as the latest value nor pollute the
        extremes, and one rank's telemetry never poses as another's)."""
        result = await self.client.query(
            """
            SELECT run_id, metric_name, rank,
                   argMax(v, step) AS last_value,
                   max(step) AS last_step, max(latest_ts) AS last_ts,
                   min(v) AS value_min, max(v) AS value_max
            FROM (
                SELECT run_id, metric_name, rank, step,
                       argMax(value, (attempt, ts)) AS v, max(ts) AS latest_ts
                FROM metric_points
                WHERE org_id = {org:UUID} AND run_id IN {runs:Array(String)}
                GROUP BY run_id, metric_name, rank, step
            )
            GROUP BY run_id, metric_name, rank
            ORDER BY run_id, metric_name, rank
            """,
            parameters={"org": str(org_id), "runs": run_ids},
            settings=self._query_settings,
        )
        return [
            LatestMetric(
                run_id=row[0],
                metric_name=row[1],
                rank=int(row[2]),
                value=float(row[3]),
                step=int(row[4]),
                ts=row[5],
                value_min=float(row[6]),
                value_max=float(row[7]),
            )
            for row in result.result_rows
        ]

    async def logs_tail(
        self, org_id: UUID, *, run_id: str, after_ts: datetime | None, limit: int
    ) -> list[LogLine]:
        conditions = ["org_id = {org:UUID}", "run_id = {run:String}"]
        params: dict[str, object] = {"org": str(org_id), "run": run_id, "limit": limit}
        if after_ts is not None:
            conditions.append("ts > {after:DateTime64(6)}")
            params["after"] = after_ts
        result = await self.client.query(
            f"""
            SELECT run_id, ts, level, source, message
            FROM log_events WHERE {" AND ".join(conditions)}
            ORDER BY ts DESC LIMIT {{limit:UInt32}}
            """,
            parameters=params,
            settings=self._query_settings,
        )
        rows = [
            LogLine(run_id=r[0], ts=r[1], level=r[2], source=r[3], message=r[4])
            for r in result.result_rows
        ]
        rows.reverse()  # serve oldest-first within the tail window
        return rows
