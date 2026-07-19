"""Hand-written SQL over psycopg with ``class_row`` frozen dataclass rows.
Every query takes the org id explicitly — there is no unscoped variant."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, LiteralString
from uuid import UUID, uuid4

from psycopg import AsyncConnection
from psycopg.rows import class_row

from waddle_server.errors import BatchDigestMismatchError
from waddle_server.model import RunState


@dataclass(frozen=True, slots=True)
class ProjectRow:
    id: UUID
    org_id: UUID
    name: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class RunRow:
    org_id: UUID
    id: str
    project_id: UUID
    project_name: str
    name: str
    display_name: str | None
    state: str
    group_name: str | None
    job_type: str | None
    config: dict[str, object]
    summary: dict[str, object]
    commit_sha: str | None
    environment: dict[str, object]
    created_by: UUID | None
    created_at: datetime
    started_at: datetime
    finished_at: datetime | None
    heartbeat_at: datetime | None


@dataclass(frozen=True, slots=True)
class WorkerRow:
    org_id: UUID
    run_id: str
    rank: int
    local_rank: int
    world_size: int
    node_id: str
    attempt: int
    writer_id: UUID
    started_at: datetime


@dataclass(frozen=True, slots=True)
class OrgLimitsRow:
    org_id: UUID
    ingest_rpm: int | None
    max_points_per_batch: int | None


_RUN_COLUMNS: LiteralString = """
    r.org_id, r.id, r.project_id, p.name AS project_name, r.name, r.display_name,
    r.state, r.group_name, r.job_type, r.config, r.summary, r.commit_sha,
    r.environment, r.created_by, r.created_at, r.started_at, r.finished_at,
    r.heartbeat_at
"""


async def ensure_project(
    conn: AsyncConnection[Any], org_id: UUID, name: str
) -> ProjectRow:
    """Auto-create on first reference (the W&B behavior)."""
    async with conn.cursor(row_factory=class_row(ProjectRow)) as cur:
        await cur.execute(
            """
            INSERT INTO projects (id, org_id, name) VALUES (%s, %s, %s)
            ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
            RETURNING id, org_id, name, created_at
            """,
            (uuid4(), org_id, name),
        )
        row = await cur.fetchone()
        assert row is not None
        return row


async def list_projects(conn: AsyncConnection[Any], org_id: UUID) -> list[ProjectRow]:
    async with conn.cursor(row_factory=class_row(ProjectRow)) as cur:
        await cur.execute(
            "SELECT id, org_id, name, created_at FROM projects"
            " WHERE org_id = %s ORDER BY created_at DESC",
            (org_id,),
        )
        return await cur.fetchall()


async def upsert_run(
    conn: AsyncConnection[Any],
    org_id: UUID,
    run_id: str,
    *,
    project_id: UUID,
    name: str,
    display_name: str | None,
    group_name: str | None,
    job_type: str | None,
    config: dict[str, object],
    commit_sha: str | None,
    environment: dict[str, object],
    created_by: UUID | None,
    started_at: datetime,
    resume: bool,
) -> RunRow:
    """Create-or-attach: the first caller creates the run; rank>0 workers and
    resumed attempts hit the same statement. A resume reopens a settled run
    (state back to running, finished_at cleared); a plain attach refreshes
    nothing but config/commit/environment."""
    async with conn.cursor(row_factory=class_row(RunRow)) as cur:
        await cur.execute(
            f"""
            WITH upserted AS (
                INSERT INTO runs (org_id, id, project_id, name, display_name, state,
                                  group_name, job_type, config, commit_sha, environment,
                                  created_by, started_at)
                VALUES (%(org)s, %(id)s, %(project)s, %(name)s, %(display)s, 'running',
                        %(grp)s, %(job)s, %(config)s, %(commit)s, %(environment)s,
                        %(by)s, %(started)s)
                ON CONFLICT (org_id, id) DO UPDATE
                    SET config = EXCLUDED.config,
                        commit_sha = EXCLUDED.commit_sha,
                        environment = CASE WHEN EXCLUDED.environment = '{{}}'::jsonb
                                           THEN runs.environment
                                           ELSE EXCLUDED.environment END,
                        state = CASE WHEN %(resume)s THEN 'running' ELSE runs.state END,
                        finished_at = CASE WHEN %(resume)s THEN NULL ELSE runs.finished_at END
                RETURNING *
            )
            SELECT {_RUN_COLUMNS} FROM upserted r JOIN projects p ON p.id = r.project_id
            """,
            {
                "org": org_id,
                "id": run_id,
                "project": project_id,
                "name": name,
                "display": display_name,
                "grp": group_name,
                "job": job_type,
                "config": json.dumps(config),
                "commit": commit_sha,
                "environment": json.dumps(environment),
                "by": created_by,
                "started": started_at,
                "resume": resume,
            },
        )
        row = await cur.fetchone()
        assert row is not None
        return row


async def attach_worker(
    conn: AsyncConnection[Any],
    org_id: UUID,
    run_id: str,
    *,
    rank: int,
    local_rank: int,
    world_size: int,
    node_id: str,
    attempt: int,
    writer_id: UUID,
) -> None:
    await conn.execute(
        """
        INSERT INTO run_workers (org_id, run_id, rank, local_rank, world_size,
                                 node_id, attempt, writer_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (org_id, run_id, rank, attempt) DO UPDATE SET writer_id = EXCLUDED.writer_id
        """,
        (org_id, run_id, rank, local_rank, world_size, node_id, attempt, writer_id),
    )


async def get_run(
    conn: AsyncConnection[Any], org_id: UUID, run_id: str
) -> RunRow | None:
    async with conn.cursor(row_factory=class_row(RunRow)) as cur:
        await cur.execute(
            f"SELECT {_RUN_COLUMNS} FROM runs r JOIN projects p ON p.id = r.project_id"
            " WHERE r.org_id = %s AND r.id = %s",
            (org_id, run_id),
        )
        return await cur.fetchone()


async def list_runs(
    conn: AsyncConnection[Any],
    org_id: UUID,
    *,
    project: str | None,
    state: RunState | None,
    group_name: str | None,
    job_type: str | None,
    limit: int,
) -> list[RunRow]:
    async with conn.cursor(row_factory=class_row(RunRow)) as cur:
        await cur.execute(
            f"""
            SELECT {_RUN_COLUMNS} FROM runs r JOIN projects p ON p.id = r.project_id
            WHERE r.org_id = %(org)s
              AND (%(project)s::text IS NULL OR p.name = %(project)s)
              AND (%(state)s::text IS NULL OR r.state = %(state)s)
              AND (%(group)s::text IS NULL OR r.group_name = %(group)s)
              AND (%(job)s::text IS NULL OR r.job_type = %(job)s)
            ORDER BY r.created_at DESC LIMIT %(limit)s
            """,
            {
                "org": org_id,
                "project": project,
                "state": state.value if state is not None else None,
                "group": group_name,
                "job": job_type,
                "limit": limit,
            },
        )
        return await cur.fetchall()


async def list_workers(
    conn: AsyncConnection[Any], org_id: UUID, run_id: str
) -> list[WorkerRow]:
    async with conn.cursor(row_factory=class_row(WorkerRow)) as cur:
        await cur.execute(
            "SELECT org_id, run_id, rank, local_rank, world_size, node_id, attempt,"
            " writer_id, started_at FROM run_workers"
            " WHERE org_id = %s AND run_id = %s ORDER BY rank, attempt",
            (org_id, run_id),
        )
        return await cur.fetchall()


async def finish_run(
    conn: AsyncConnection[Any],
    org_id: UUID,
    run_id: str,
    *,
    state: RunState,
    summary: dict[str, object] | None,
) -> RunRow | None:
    async with conn.cursor(row_factory=class_row(RunRow)) as cur:
        await cur.execute(
            f"""
            WITH updated AS (
                UPDATE runs SET state = %s, finished_at = now(),
                                summary = summary || %s::jsonb
                WHERE org_id = %s AND id = %s
                RETURNING *
            )
            SELECT {_RUN_COLUMNS} FROM updated r JOIN projects p ON p.id = r.project_id
            """,
            (state.value, json.dumps(summary or {}), org_id, run_id),
        )
        return await cur.fetchone()


async def record_batch(
    conn: AsyncConnection[Any],
    org_id: UUID,
    *,
    batch_id: UUID,
    run_id: str,
    writer_id: UUID,
    payload_sha256: str,
    sequence_start: int,
    sequence_end: int,
) -> bool:
    """Ledger upsert. Returns True if this batch_id was already ingested with
    identical bytes (a replay); raises on a digest mismatch."""
    row = await (
        await conn.execute(
            """
            INSERT INTO run_batches (org_id, batch_id, run_id, writer_id, payload_sha256,
                                     sequence_start, sequence_end)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (org_id, batch_id) DO NOTHING
            RETURNING batch_id
            """,
            (
                org_id,
                batch_id,
                run_id,
                writer_id,
                payload_sha256,
                sequence_start,
                sequence_end,
            ),
        )
    ).fetchone()
    if row is not None:
        return False
    stored = await (
        await conn.execute(
            "SELECT payload_sha256 FROM run_batches WHERE org_id = %s AND batch_id = %s",
            (org_id, batch_id),
        )
    ).fetchone()
    assert stored is not None
    if stored[0] != payload_sha256:
        raise BatchDigestMismatchError(str(batch_id))
    return True


async def last_sequence_end(
    conn: AsyncConnection[Any], org_id: UUID, run_id: str, writer_id: UUID
) -> int | None:
    row = await (
        await conn.execute(
            "SELECT max(sequence_end) FROM run_batches"
            " WHERE org_id = %s AND run_id = %s AND writer_id = %s",
            (org_id, run_id, writer_id),
        )
    ).fetchone()
    return row[0] if row is not None else None


async def touch_run(
    conn: AsyncConnection[Any], org_id: UUID, run_id: str, *, summary: dict[str, float]
) -> None:
    """Heartbeat + latest-scalar summary merge, so run tables render from
    Postgres alone."""
    await conn.execute(
        "UPDATE runs SET heartbeat_at = now(), summary = summary || %s::jsonb"
        " WHERE org_id = %s AND id = %s",
        (json.dumps(summary), org_id, run_id),
    )


async def org_limits(conn: AsyncConnection[Any], org_id: UUID) -> OrgLimitsRow | None:
    async with conn.cursor(row_factory=class_row(OrgLimitsRow)) as cur:
        await cur.execute(
            "SELECT org_id, ingest_rpm, max_points_per_batch FROM org_limits WHERE org_id = %s",
            (org_id,),
        )
        return await cur.fetchone()


@dataclass(frozen=True, slots=True)
class ReportRow:
    id: UUID
    org_id: UUID
    name: str
    version: int
    title: str | None
    description: str | None
    body: str
    updated_by: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ReportVersionRow:
    report_id: UUID
    version: int
    name: str
    body: str
    updated_by: str | None
    created_at: datetime


_REPORT_COLUMNS: LiteralString = "id, org_id, name, version, title, description, body, updated_by, created_at, updated_at"
_VERSION_COLUMNS: LiteralString = (
    "report_id, version, name, body, updated_by, created_at"
)


async def create_report(
    conn: AsyncConnection[Any],
    org_id: UUID,
    *,
    name: str,
    title: str | None,
    description: str | None,
    body: str,
    updated_by: str | None,
) -> ReportRow | None:
    """Create version 1; ``None`` means the name is already taken in this org."""
    async with conn.cursor(row_factory=class_row(ReportRow)) as cur:
        await cur.execute(
            f"""
            INSERT INTO reports (org_id, name, title, description, body, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (org_id, name) DO NOTHING
            RETURNING {_REPORT_COLUMNS}
            """,
            (org_id, name, title, description, body, updated_by),
        )
        row = await cur.fetchone()
    if row is not None:
        await _append_version(conn, row)
    return row


async def update_report(
    conn: AsyncConnection[Any],
    org_id: UUID,
    report_id: UUID,
    *,
    name: str,
    title: str | None,
    description: str | None,
    body: str,
    updated_by: str | None,
) -> ReportRow | None:
    """Bump the version and append it to the history (rename rides the same
    save). Runs inside the request's transaction, so the reports row and its
    version row commit together."""
    async with conn.cursor(row_factory=class_row(ReportRow)) as cur:
        await cur.execute(
            f"""
            UPDATE reports
            SET name = %s, title = %s, description = %s, body = %s,
                updated_by = %s, version = version + 1, updated_at = now()
            WHERE org_id = %s AND id = %s
            RETURNING {_REPORT_COLUMNS}
            """,
            (name, title, description, body, updated_by, org_id, report_id),
        )
        row = await cur.fetchone()
    if row is not None:
        await _append_version(conn, row)
    return row


async def _append_version(conn: AsyncConnection[Any], row: ReportRow) -> None:
    await conn.execute(
        """
        INSERT INTO report_versions (report_id, org_id, version, name, body, updated_by)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (row.id, row.org_id, row.version, row.name, row.body, row.updated_by),
    )


async def list_reports(
    conn: AsyncConnection[Any], org_id: UUID, *, name: str | None = None
) -> list[ReportRow]:
    async with conn.cursor(row_factory=class_row(ReportRow)) as cur:
        if name is None:
            await cur.execute(
                f"SELECT {_REPORT_COLUMNS} FROM reports WHERE org_id = %s ORDER BY name",
                (org_id,),
            )
        else:
            await cur.execute(
                f"SELECT {_REPORT_COLUMNS} FROM reports WHERE org_id = %s AND name = %s",
                (org_id, name),
            )
        return await cur.fetchall()


async def get_report(
    conn: AsyncConnection[Any], org_id: UUID, report_id: UUID
) -> ReportRow | None:
    async with conn.cursor(row_factory=class_row(ReportRow)) as cur:
        await cur.execute(
            f"SELECT {_REPORT_COLUMNS} FROM reports WHERE org_id = %s AND id = %s",
            (org_id, report_id),
        )
        return await cur.fetchone()


async def delete_report(
    conn: AsyncConnection[Any], org_id: UUID, report_id: UUID
) -> bool:
    result = await conn.execute(
        "DELETE FROM reports WHERE org_id = %s AND id = %s", (org_id, report_id)
    )
    return result.rowcount > 0


async def list_report_versions(
    conn: AsyncConnection[Any], org_id: UUID, report_id: UUID
) -> list[ReportVersionRow]:
    async with conn.cursor(row_factory=class_row(ReportVersionRow)) as cur:
        await cur.execute(
            f"""
            SELECT {_VERSION_COLUMNS} FROM report_versions
            WHERE org_id = %s AND report_id = %s ORDER BY version DESC
            """,
            (org_id, report_id),
        )
        return await cur.fetchall()


async def get_report_version(
    conn: AsyncConnection[Any], org_id: UUID, report_id: UUID, version: int
) -> ReportVersionRow | None:
    async with conn.cursor(row_factory=class_row(ReportVersionRow)) as cur:
        await cur.execute(
            f"""
            SELECT {_VERSION_COLUMNS} FROM report_versions
            WHERE org_id = %s AND report_id = %s AND version = %s
            """,
            (org_id, report_id, version),
        )
        return await cur.fetchone()
