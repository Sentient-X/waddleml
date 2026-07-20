"""Artifact metadata: collections, content-addressed versions, files, aliases,
and run lineage. Same house rules as repo.py — org id on every query."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from psycopg import AsyncConnection
from psycopg.rows import class_row


@dataclass(frozen=True, slots=True)
class CollectionRow:
    id: UUID
    org_id: UUID
    project_id: UUID
    name: str
    kind: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class VersionRow:
    id: UUID
    org_id: UUID
    collection_id: UUID
    collection_name: str
    version_number: int
    digest: str
    metadata: dict[str, object]
    manifest: dict[str, object]
    created_by_run_id: str | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class FileRow:
    artifact_version_id: UUID
    logical_path: str
    blob_sha256: str
    r2_key: str
    size_bytes: int
    media_type: str | None


@dataclass(frozen=True, slots=True)
class CommitOutcome:
    """One committed version plus whether this commit minted it (content
    identity: an identical digest reuses the existing version)."""

    version: VersionRow
    created: bool


@dataclass(frozen=True, slots=True)
class LineageRow:
    run_id: str
    artifact_version_id: UUID
    relation: str
    collection_name: str
    version_number: int


@dataclass(frozen=True, slots=True)
class UploadSessionRow:
    id: UUID
    org_id: UUID
    state: str
    files: list[dict[str, object]]
    created_at: datetime
    expires_at: datetime


async def ensure_collection(
    conn: AsyncConnection[Any], org_id: UUID, project_id: UUID, name: str, kind: str
) -> CollectionRow:
    async with conn.cursor(row_factory=class_row(CollectionRow)) as cur:
        await cur.execute(
            """
            INSERT INTO artifact_collections (id, org_id, project_id, name, kind)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (org_id, project_id, name) DO UPDATE SET kind = EXCLUDED.kind
            RETURNING id, org_id, project_id, name, kind, created_at
            """,
            (uuid4(), org_id, project_id, name, kind),
        )
        row = await cur.fetchone()
        assert row is not None
        return row


async def commit_version(
    conn: AsyncConnection[Any],
    org_id: UUID,
    collection: CollectionRow,
    *,
    digest: str,
    metadata: dict[str, object],
    manifest: dict[str, object],
    created_by_run_id: str | None,
    files: list[tuple[str, str, str, int, str | None]],
) -> CommitOutcome:
    """Atomically mint the next version number and record its file manifest.
    Content identity: a collection holds exactly one version per manifest
    digest — committing identical content returns the existing version so the
    caller can still attach its lineage edge."""
    async with conn.cursor(row_factory=class_row(VersionRow)) as cur:
        await cur.execute(
            """
            SELECT v.id, v.org_id, v.collection_id, %(name)s AS collection_name,
                   v.version_number, v.digest, v.metadata, v.manifest,
                   v.created_by_run_id, v.created_at
            FROM artifact_versions v
            WHERE v.collection_id = %(coll)s AND v.digest = %(digest)s
            """,
            {"name": collection.name, "coll": collection.id, "digest": digest},
        )
        existing = await cur.fetchone()
    if existing is not None:
        return CommitOutcome(version=existing, created=False)
    version_id = uuid4()
    async with conn.cursor(row_factory=class_row(VersionRow)) as cur:
        await cur.execute(
            """
            WITH next AS (
                SELECT COALESCE(max(version_number), -1) + 1 AS n
                FROM artifact_versions WHERE collection_id = %(coll)s
            ), inserted AS (
                INSERT INTO artifact_versions
                    (id, org_id, collection_id, version_number, digest, metadata,
                     manifest, created_by_run_id)
                SELECT %(id)s, %(org)s, %(coll)s, next.n, %(digest)s, %(metadata)s,
                       %(manifest)s, %(run)s
                FROM next
                RETURNING *
            )
            SELECT i.id, i.org_id, i.collection_id, %(name)s AS collection_name,
                   i.version_number, i.digest, i.metadata, i.manifest,
                   i.created_by_run_id, i.created_at
            FROM inserted i
            """,
            {
                "id": version_id,
                "org": org_id,
                "coll": collection.id,
                "digest": digest,
                "metadata": json.dumps(metadata),
                "manifest": json.dumps(manifest),
                "run": created_by_run_id,
                "name": collection.name,
            },
        )
        version = await cur.fetchone()
        assert version is not None
    for logical_path, blob_sha256, r2_key, size_bytes, media_type in files:
        await conn.execute(
            "INSERT INTO artifact_files (artifact_version_id, logical_path, blob_sha256,"
            " r2_key, size_bytes, media_type) VALUES (%s, %s, %s, %s, %s, %s)",
            (version_id, logical_path, blob_sha256, r2_key, size_bytes, media_type),
        )
    return CommitOutcome(version=version, created=True)


async def get_version(
    conn: AsyncConnection[Any], org_id: UUID, version_id: UUID
) -> tuple[VersionRow, list[FileRow]] | None:
    async with conn.cursor(row_factory=class_row(VersionRow)) as cur:
        await cur.execute(
            """
            SELECT v.id, v.org_id, v.collection_id, c.name AS collection_name,
                   v.version_number, v.digest, v.metadata, v.manifest,
                   v.created_by_run_id, v.created_at
            FROM artifact_versions v JOIN artifact_collections c ON c.id = v.collection_id
            WHERE v.org_id = %s AND v.id = %s
            """,
            (org_id, version_id),
        )
        version = await cur.fetchone()
    if version is None:
        return None
    async with conn.cursor(row_factory=class_row(FileRow)) as cur:
        await cur.execute(
            "SELECT artifact_version_id, logical_path, blob_sha256, r2_key, size_bytes,"
            " media_type FROM artifact_files WHERE artifact_version_id = %s"
            " ORDER BY logical_path",
            (version_id,),
        )
        files = await cur.fetchall()
    return version, files


async def set_alias(
    conn: AsyncConnection[Any], collection_id: UUID, alias: str, version_id: UUID
) -> None:
    await conn.execute(
        """
        INSERT INTO artifact_aliases (collection_id, alias, version_id)
        VALUES (%s, %s, %s)
        ON CONFLICT (collection_id, alias) DO UPDATE SET version_id = EXCLUDED.version_id
        """,
        (collection_id, alias, version_id),
    )


async def record_lineage(
    conn: AsyncConnection[Any], org_id: UUID, run_id: str, version_id: UUID, relation: str
) -> None:
    await conn.execute(
        "INSERT INTO artifact_lineage (org_id, run_id, artifact_version_id, relation)"
        " VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
        (org_id, run_id, version_id, relation),
    )


async def run_lineage(
    conn: AsyncConnection[Any], org_id: UUID, run_id: str
) -> list[LineageRow]:
    async with conn.cursor(row_factory=class_row(LineageRow)) as cur:
        await cur.execute(
            """
            SELECT l.run_id, l.artifact_version_id, l.relation,
                   c.name AS collection_name, v.version_number
            FROM artifact_lineage l
            JOIN artifact_versions v ON v.id = l.artifact_version_id
            JOIN artifact_collections c ON c.id = v.collection_id
            WHERE l.org_id = %s AND l.run_id = %s
            ORDER BY l.relation, c.name, v.version_number
            """,
            (org_id, run_id),
        )
        return await cur.fetchall()


async def create_upload_session(
    conn: AsyncConnection[Any], org_id: UUID, files: list[dict[str, object]], ttl_s: int
) -> UploadSessionRow:
    async with conn.cursor(row_factory=class_row(UploadSessionRow)) as cur:
        await cur.execute(
            """
            INSERT INTO upload_sessions (id, org_id, state, files, expires_at)
            VALUES (%s, %s, 'open', %s, %s)
            RETURNING id, org_id, state, files, created_at, expires_at
            """,
            (uuid4(), org_id, json.dumps(files), datetime.now(UTC) + timedelta(seconds=ttl_s)),
        )
        row = await cur.fetchone()
        assert row is not None
        return row


async def get_upload_session(
    conn: AsyncConnection[Any], org_id: UUID, session_id: UUID
) -> UploadSessionRow | None:
    async with conn.cursor(row_factory=class_row(UploadSessionRow)) as cur:
        await cur.execute(
            "SELECT id, org_id, state, files, created_at, expires_at FROM upload_sessions"
            " WHERE org_id = %s AND id = %s",
            (org_id, session_id),
        )
        return await cur.fetchone()


async def mark_session(
    conn: AsyncConnection[Any], session_id: UUID, state: str
) -> None:
    await conn.execute(
        "UPDATE upload_sessions SET state = %s WHERE id = %s", (state, session_id)
    )


async def expire_stale_sessions(conn: AsyncConnection[Any]) -> int:
    result = await conn.execute(
        "UPDATE upload_sessions SET state = 'expired'"
        " WHERE state = 'open' AND expires_at < now()"
    )
    return result.rowcount or 0
