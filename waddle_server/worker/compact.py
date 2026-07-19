"""The compaction/reconciliation worker (``python -m waddle_server.worker.compact``).

A plain periodic loop — idempotent sweeps don't need Temporal (revisit only if
jobs grow real dependencies). Each sweep, per org:

1. **Parquet export** — ClickHouse metric/log partitions and the Postgres
   runs/params snapshot land as org-partitioned Parquet under
   ``orgs/{org}/parquet/…`` on R2. This layer feeds the agent SQL sandbox and
   outlives ClickHouse TTLs. Month partitions re-export only when ClickHouse
   holds newer rows than the recorded watermark (``parquet_exports``).
2. **Upload-session sweep** — sessions past their TTL flip to expired.
3. **Digest sampling** — a bounded sample of artifact blobs is re-hashed
   against its content address; a mismatch is logged loudly (corruption is an
   operator page, never an auto-delete — nothing here ever deletes data).

DuckDB does the Parquet writing (Arrow in → COPY TO parquet), keeping the
worker free of a pandas/pyarrow dependency.
"""

from __future__ import annotations

import asyncio
import hashlib
import tempfile
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import duckdb
import psycopg
from sx_observability import configure_logging, get_logger

from waddle_server.config import WaddleSettings
from waddle_server.server import artifacts, ch, db
from waddle_server.server.storage import ObjectStore, parquet_key

log = get_logger(__name__)

SWEEP_INTERVAL_S = 300.0
DIGEST_SAMPLE_PER_SWEEP = 5
DIGEST_SAMPLE_MAX_BYTES = 64 * 1024 * 1024


async def _org_ids(conn: psycopg.AsyncConnection[Any]) -> list[UUID]:
    rows = await (await conn.execute("SELECT DISTINCT org_id FROM runs")).fetchall()
    return [row[0] for row in rows]


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


METRIC_COLUMNS = [
    ("run_id", "VARCHAR"), ("metric_name", "VARCHAR"), ("step", "BIGINT"),
    ("ts", "TIMESTAMP"), ("value", "DOUBLE"), ("rank", "INTEGER"),
    ("node_id", "VARCHAR"), ("attempt", "INTEGER"),
]
LOG_COLUMNS = [
    ("run_id", "VARCHAR"), ("ts", "TIMESTAMP"), ("level", "VARCHAR"),
    ("source", "VARCHAR"), ("message", "VARCHAR"),
]
RUN_COLUMNS = [
    ("run_id", "VARCHAR"), ("project", "VARCHAR"), ("name", "VARCHAR"),
    ("state", "VARCHAR"), ("group_name", "VARCHAR"), ("job_type", "VARCHAR"),
    ("config", "VARCHAR"), ("summary", "VARCHAR"), ("commit_sha", "VARCHAR"),
    ("created_at", "TIMESTAMPTZ"), ("started_at", "TIMESTAMPTZ"),
    ("finished_at", "TIMESTAMPTZ"),
]


def _write_parquet(
    rows: Sequence[Sequence[Any]], columns: list[tuple[str, str]], dest: Path
) -> None:
    conn = duckdb.connect()
    try:
        ddl = ", ".join(f'"{name}" {kind}' for name, kind in columns)
        conn.execute(f"CREATE TABLE export ({ddl})")
        if rows:
            placeholders = ", ".join("?" for _ in columns)
            conn.executemany(f"INSERT INTO export VALUES ({placeholders})", rows)
        conn.execute(f"COPY export TO '{dest}' (FORMAT parquet)")
    finally:
        conn.close()


class Compactor:
    def __init__(self, cfg: WaddleSettings) -> None:
        self._cfg = cfg
        self._store = ObjectStore(cfg)
        self._ch = ch.MetricStore(cfg)

    async def sweep_once(self) -> None:
        async with await psycopg.AsyncConnection.connect(self._cfg.pg_dsn) as conn:
            await conn.set_autocommit(True)
            expired = await artifacts.expire_stale_sessions(conn)
            if expired:
                log.info("expired upload sessions", extra={"count": expired})
            for org_id in await _org_ids(conn):
                await self._export_org(conn, org_id)
                await self._sample_digests(conn, org_id)

    async def _export_org(self, conn: psycopg.AsyncConnection[Any], org_id: UUID) -> None:
        await self._export_pg_snapshot(conn, org_id)
        for dataset, table, ts_col in (("metrics", "metric_points", "ts"), ("logs", "log_events", "ts")):
            months = await self._ch.client.query(
                f"SELECT toYYYYMM({ts_col}) AS m, max({ts_col}) FROM {table}"
                " WHERE org_id = {org:UUID} GROUP BY m",
                parameters={"org": str(org_id)},
            )
            for month, raw_max_ts in months.result_rows:
                # ClickHouse client datetimes are naive UTC; Postgres timestamptz
                # is aware — normalize before comparing or storing.
                max_ts = _as_utc(raw_max_ts)
                partition = f"month={month}"
                stale = await (
                    await conn.execute(
                        "SELECT max_ts FROM parquet_exports"
                        " WHERE org_id = %s AND dataset = %s AND partition = %s",
                        (org_id, dataset, partition),
                    )
                ).fetchone()
                if stale is not None and stale[0] is not None and _as_utc(stale[0]) >= max_ts:
                    continue
                await self._export_ch_partition(org_id, dataset, table, int(month), partition)
                await conn.execute(
                    """
                    INSERT INTO parquet_exports (org_id, dataset, partition, max_ts)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (org_id, dataset, partition)
                        DO UPDATE SET max_ts = EXCLUDED.max_ts, exported_at = now()
                    """,
                    (org_id, dataset, partition, max_ts),
                )

    async def _export_ch_partition(
        self, org_id: UUID, dataset: str, table: str, month: int, partition: str
    ) -> None:
        columns = METRIC_COLUMNS if dataset == "metrics" else LOG_COLUMNS
        quoted = ", ".join(f'"{name}"' for name, _ in columns)
        result = await self._ch.client.query(
            f"SELECT {quoted} FROM {table}"
            " WHERE org_id = {org:UUID} AND toYYYYMM(ts) = {month:UInt32}"
            " ORDER BY run_id, ts",
            parameters={"org": str(org_id), "month": month},
        )
        with tempfile.TemporaryDirectory() as scratch:
            dest = Path(scratch) / "part.parquet"
            _write_parquet(list(result.result_rows), columns, dest)
            self._store.put_file_replace(dest, parquet_key(org_id, dataset, partition))
        log.info(
            "exported parquet partition",
            extra={"org": str(org_id), "dataset": dataset, "partition": partition,
                   "rows": len(result.result_rows)},
        )

    async def _export_pg_snapshot(self, conn: psycopg.AsyncConnection[Any], org_id: UUID) -> None:
        runs = await (
            await conn.execute(
                """
                SELECT r.id, p.name, r.name, r.state, r.group_name, r.job_type,
                       r.config::text, r.summary::text, r.commit_sha,
                       r.created_at, r.started_at, r.finished_at
                FROM runs r JOIN projects p ON p.id = r.project_id
                WHERE r.org_id = %s
                """,
                (org_id,),
            )
        ).fetchall()
        if not runs:
            return
        with tempfile.TemporaryDirectory() as scratch:
            dest = Path(scratch) / "runs.parquet"
            _write_parquet([tuple(row) for row in runs], RUN_COLUMNS, dest)
            self._store.put_file_replace(dest, parquet_key(org_id, "runs", "snapshot"))

    async def _sample_digests(self, conn: psycopg.AsyncConnection[Any], org_id: UUID) -> None:
        rows = await (
            await conn.execute(
                """
                SELECT f.blob_sha256, f.r2_key, f.size_bytes
                FROM artifact_files f
                JOIN artifact_versions v ON v.id = f.artifact_version_id
                WHERE v.org_id = %s AND f.size_bytes <= %s
                ORDER BY random() LIMIT %s
                """,
                (org_id, DIGEST_SAMPLE_MAX_BYTES, DIGEST_SAMPLE_PER_SWEEP),
            )
        ).fetchall()
        for sha256, r2_key, _size in rows:
            actual = hashlib.sha256(self._store.get_bytes(r2_key)).hexdigest()
            if actual != sha256:
                log.error(
                    "artifact blob digest mismatch — investigate immediately",
                    extra={"key": r2_key, "declared": sha256, "actual": actual},
                )

    async def run_forever(self) -> None:
        db.migrate(self._cfg.pg_dsn)
        if self._cfg.ensure_bucket:
            self._store.ensure_bucket()
        await self._ch.open()
        log.info("waddle compactor up", extra={"interval_s": SWEEP_INTERVAL_S})
        try:
            while True:
                started = datetime.now()
                try:
                    await self.sweep_once()
                except Exception:
                    log.exception("sweep failed; retrying next interval")
                elapsed = (datetime.now() - started).total_seconds()
                await asyncio.sleep(max(1.0, SWEEP_INTERVAL_S - elapsed))
        finally:
            await self._ch.close()


def main() -> None:
    configure_logging(service="waddle-worker")
    asyncio.run(Compactor(WaddleSettings()).run_forever())


if __name__ == "__main__":
    main()
