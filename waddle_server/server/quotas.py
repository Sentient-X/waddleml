"""Atomic Postgres-owned ingest metering shared by every API replica."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.rows import class_row

from waddle_server.errors import QuotaConfigurationError, QuotaExceededError


@dataclass(frozen=True, slots=True)
class RateDecision:
    admitted: bool
    retry_after_s: int


async def check_rpm(
    conn: AsyncConnection[Any],
    org_id: UUID,
    org_slug: str,
    limit: int,
) -> None:
    if limit < 1:
        raise QuotaConfigurationError("ingest_rpm must be positive")
    async with conn.cursor(row_factory=class_row(RateDecision)) as cursor:
        decision = await (
            await cursor.execute(
                """
                WITH attempted AS (
                    INSERT INTO ingest_rate_windows (org_id, window_start, request_count)
                    VALUES (%s, date_trunc('minute', now()), 1)
                    ON CONFLICT (org_id, window_start) DO UPDATE
                    SET request_count = ingest_rate_windows.request_count + 1
                    WHERE ingest_rate_windows.request_count < %s
                    RETURNING request_count
                )
                SELECT EXISTS(SELECT 1 FROM attempted) AS admitted,
                       GREATEST(
                           1,
                           CEIL(EXTRACT(EPOCH FROM (
                               date_trunc('minute', now()) + interval '1 minute' - now()
                           )))::integer
                       ) AS retry_after_s
                """,
                (org_id, limit),
            )
        ).fetchone()
    if decision is None:
        raise QuotaConfigurationError("rate counter returned no decision")
    if not decision.admitted:
        raise QuotaExceededError(
            org_slug,
            f"ingest rate limit of {limit}/min exceeded",
            decision.retry_after_s,
        )
