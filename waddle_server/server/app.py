# pyright: reportUnusedFunction=false
# (route handlers and the SPA fallback are registered via FastAPI decorators)
"""The waddle platform control plane (:8400).

Ingest path: batch validate → org check → rpm quota → ClickHouse insert
(block-dedup absorbs retries) → Postgres ledger upsert (replay/mismatch
decision) → heartbeat + summary merge. The response commits only after both
stores acknowledged. Query paths read ClickHouse (series/latest/logs) or
Postgres (runs/projects) — always org-filtered from the introspected principal.
"""

from __future__ import annotations

import gzip
import hashlib
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pydantic
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from psycopg import AsyncConnection
from sx_auth.client import AuthClient
from sx_observability import ObservabilityMiddleware, configure_logging, get_logger

from waddle_server import sqlbox
from waddle_server.config import WaddleSettings
from waddle_server.errors import (
    BatchDigestMismatchError,
    BatchLimitError,
    QueryLimitError,
    QuotaExceededError,
    RunNotFoundError,
    SqlSandboxError,
)
from waddle_server.model import RunState, WaddleRole
from waddle_server.server import artifacts, ch, db, quotas, repo
from waddle_server.server.auth import WaddlePrincipal, require_role, resolve_principal
from waddle_server.server.schemas import (
    AliasIn,
    ArtifactFileOut,
    ArtifactVersionOut,
    BatchAck,
    BatchIn,
    CommitArtifactIn,
    CreateRunIn,
    CreateUploadSessionIn,
    ErrorOut,
    FinishRunIn,
    HealthOut,
    LatestMetricOut,
    LogLineOut,
    MetricSeriesOut,
    MetricsQueryIn,
    ProjectOut,
    RunDetailOut,
    RunLineageOut,
    RunOut,
    RunRef,
    SeriesPointOut,
    SqlQueryIn,
    SqlResultOut,
    UploadSessionOut,
    UploadTargetOut,
    WorkerOut,
)
from waddle_server.server.storage import ObjectStore, blob_key

log = get_logger(__name__)


def _error(status: int, exc: Exception, code: str) -> HTTPException:
    return HTTPException(status, ErrorOut(code=code, message=str(exc)).model_dump())


def build_app(
    settings: WaddleSettings | None = None,
    auth_client: AuthClient | None = None,
    metric_store: ch.MetricStore | None = None,
    object_store: ObjectStore | None = None,
) -> FastAPI:
    cfg = settings or WaddleSettings()
    configure_logging(service="waddle")
    pool = db.make_pool(cfg.pg_dsn)
    store = metric_store or ch.MetricStore(cfg)
    blobs = object_store or ObjectStore(cfg)
    client = auth_client or AuthClient(
        base_url=cfg.auth_url, service_key=cfg.auth_service_key, audience="waddle"
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None, None]:
        applied = db.migrate(cfg.pg_dsn)
        if applied:
            log.info("migrations applied", extra={"files": applied})
        if cfg.ensure_bucket:
            blobs.ensure_bucket()
        await store.open()
        await pool.open()
        yield
        await pool.close()
        await store.close()
        await client.http.aclose()

    app = FastAPI(title="waddle", version="0.1.0", lifespan=lifespan)
    app.add_middleware(ObservabilityMiddleware)

    async def conn() -> AsyncIterator[AsyncConnection[Any]]:
        async with pool.connection() as c:
            yield c

    async def principal(request: Request) -> WaddlePrincipal:
        return await resolve_principal(request, client, auth_required=cfg.auth_required)

    @app.get("/api/healthz", response_model=HealthOut)
    async def healthz() -> HealthOut:
        return HealthOut(ok=True)

    def _run_out(row: repo.RunRow) -> RunOut:
        return RunOut(
            run_id=row.id,
            project=row.project_name,
            name=row.name,
            display_name=row.display_name,
            state=RunState(row.state),
            group_name=row.group_name,
            job_type=row.job_type,
            config=row.config,
            summary=row.summary,
            commit_sha=row.commit_sha,
            created_at=row.created_at,
            started_at=row.started_at,
            finished_at=row.finished_at,
            heartbeat_at=row.heartbeat_at,
        )

    async def _run_or_404(
        c: AsyncConnection[Any], pr: WaddlePrincipal, run_id: str
    ) -> repo.RunRow:
        # Cross-org access is 404 (existence-hiding), never 403.
        row = await repo.get_run(c, pr.org_id, run_id)
        if row is None:
            raise _error(404, RunNotFoundError(run_id), RunNotFoundError.code)
        return row

    # ── runs ─────────────────────────────────────────────────────────────────

    @app.post("/api/v1/runs", response_model=RunRef)
    async def create_run(
        body: CreateRunIn,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> RunRef:
        require_role(pr, WaddleRole.WRITER)
        project = await repo.ensure_project(c, pr.org_id, body.project)
        await repo.upsert_run(
            c,
            pr.org_id,
            body.run_id,
            project_id=project.id,
            name=body.name,
            display_name=body.display_name,
            group_name=body.group_name,
            job_type=body.job_type,
            config=body.config,
            commit_sha=body.commit_sha,
            created_by=pr.principal_id,
            started_at=body.started_at,
            resume=body.resume,
        )
        await repo.attach_worker(
            c,
            pr.org_id,
            body.run_id,
            rank=body.worker.rank,
            local_rank=body.worker.local_rank,
            world_size=body.worker.world_size,
            node_id=body.worker.node_id,
            attempt=body.worker.attempt,
            writer_id=body.worker.writer_id,
        )
        return RunRef(
            run_id=body.run_id,
            project=body.project,
            org_slug=pr.org_slug,
            url=f"/runs/{body.run_id}",
        )

    @app.get("/api/v1/runs", response_model=list[RunOut])
    async def list_runs(
        project: str | None = None,
        state: RunState | None = None,
        limit: int = Query(default=200, ge=1, le=1000),
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> list[RunOut]:
        require_role(pr, WaddleRole.READER)
        rows = await repo.list_runs(c, pr.org_id, project=project, state=state, limit=limit)
        return [_run_out(r) for r in rows]

    @app.get("/api/v1/runs/{run_id}", response_model=RunDetailOut)
    async def get_run(
        run_id: str,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> RunDetailOut:
        require_role(pr, WaddleRole.READER)
        row = await _run_or_404(c, pr, run_id)
        workers = await repo.list_workers(c, pr.org_id, run_id)
        return RunDetailOut(
            **_run_out(row).model_dump(),
            workers=[
                WorkerOut(
                    rank=w.rank,
                    local_rank=w.local_rank,
                    world_size=w.world_size,
                    node_id=w.node_id,
                    attempt=w.attempt,
                    started_at=w.started_at,
                )
                for w in workers
            ],
        )

    @app.post("/api/v1/runs/{run_id}/finish", response_model=RunOut)
    async def finish_run(
        run_id: str,
        body: FinishRunIn,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> RunOut:
        require_role(pr, WaddleRole.WRITER)
        await _run_or_404(c, pr, run_id)
        row = await repo.finish_run(c, pr.org_id, run_id, state=body.state, summary=body.summary)
        assert row is not None
        return _run_out(row)

    @app.get("/api/v1/projects", response_model=list[ProjectOut])
    async def list_projects(
        c: AsyncConnection[Any] = Depends(conn), pr: WaddlePrincipal = Depends(principal)
    ) -> list[ProjectOut]:
        require_role(pr, WaddleRole.READER)
        rows = await repo.list_projects(c, pr.org_id)
        return [ProjectOut(name=r.name, created_at=r.created_at) for r in rows]

    # ── ingest ───────────────────────────────────────────────────────────────

    @app.post("/api/v1/runs/{run_id}/batches", response_model=BatchAck)
    async def ingest_batch(
        run_id: str,
        request: Request,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> BatchAck:
        require_role(pr, WaddleRole.WRITER)
        raw = await request.body()
        if request.headers.get("content-encoding") == "gzip":
            try:
                raw = gzip.decompress(raw)
            except OSError as err:
                raise _error(400, BatchLimitError("invalid gzip body"), "invalid_body") from err
        if len(raw) > cfg.max_batch_bytes:
            raise _error(
                413,
                BatchLimitError(f"batch exceeds {cfg.max_batch_bytes} bytes"),
                BatchLimitError.code,
            )
        digest = hashlib.sha256(raw).hexdigest()
        try:
            body = BatchIn.model_validate_json(raw)
        except pydantic.ValidationError as err:
            raise HTTPException(422, err.errors(include_url=False)) from err

        run = await _run_or_404(c, pr, run_id)
        limits = await repo.org_limits(c, pr.org_id)
        max_points = (
            limits.max_points_per_batch
            if limits is not None and limits.max_points_per_batch is not None
            else cfg.max_points_per_batch
        )
        if len(body.metrics) + len(body.logs) > max_points:
            raise _error(
                413,
                BatchLimitError(f"batch exceeds {max_points} points"),
                BatchLimitError.code,
            )
        rpm = (
            limits.ingest_rpm
            if limits is not None and limits.ingest_rpm is not None
            else cfg.ingest_rpm
        )
        try:
            quotas.check_rpm(pr.org_id, pr.org_slug, rpm)
        except QuotaExceededError as err:
            raise _error(429, err, err.code) from err

        # ClickHouse first: a ledger-commit failure after this leaves rows that a
        # client retry re-inserts byte-identically — the dedup window drops them.
        seq = body.sequence_start
        metric_rows: list[tuple[object, ...]] = []
        for point in body.metrics:
            metric_rows.append(
                (
                    pr.org_id,
                    run.project_id,
                    run_id,
                    point.name,
                    point.step,
                    datetime.fromtimestamp(point.ts, tz=UTC),
                    point.value,
                    body.rank,
                    body.node_id,
                    body.attempt,
                    body.writer_id,
                    body.batch_id,
                    seq,
                )
            )
            seq += 1
        log_rows: list[tuple[object, ...]] = []
        for line in body.logs:
            log_rows.append(
                (
                    pr.org_id,
                    run.project_id,
                    run_id,
                    datetime.fromtimestamp(line.ts, tz=UTC),
                    line.level.value,
                    line.source,
                    line.message,
                    body.writer_id,
                    body.batch_id,
                    seq,
                )
            )
            seq += 1
        await store.insert_metrics(metric_rows)
        await store.insert_logs(log_rows)

        warnings: list[str] = []
        last_end = await repo.last_sequence_end(c, pr.org_id, run_id, body.writer_id)
        if last_end is not None and body.sequence_start > last_end + 1:
            warnings.append(
                f"sequence gap: expected {last_end + 1}, got {body.sequence_start}"
            )
        try:
            replayed = await repo.record_batch(
                c,
                pr.org_id,
                batch_id=body.batch_id,
                run_id=run_id,
                writer_id=body.writer_id,
                payload_sha256=digest,
                sequence_start=body.sequence_start,
                sequence_end=body.sequence_end,
            )
        except BatchDigestMismatchError as err:
            raise _error(409, err, err.code) from err

        if not replayed:
            latest: dict[str, float] = {}
            best_step: dict[str, int] = {}
            for point in body.metrics:
                if point.name not in best_step or point.step >= best_step[point.name]:
                    best_step[point.name] = point.step
                    latest[point.name] = point.value
            await repo.touch_run(c, pr.org_id, run_id, summary=latest)
        return BatchAck(batch_id=body.batch_id, replayed=replayed, warnings=warnings)

    # ── queries ──────────────────────────────────────────────────────────────

    @app.post("/api/v1/query/metrics", response_model=list[MetricSeriesOut])
    async def query_metrics(
        body: MetricsQueryIn,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> list[MetricSeriesOut]:
        require_role(pr, WaddleRole.READER)
        if len(body.run_ids) > cfg.max_query_runs:
            raise _error(
                422,
                QueryLimitError(f"at most {cfg.max_query_runs} runs per query"),
                QueryLimitError.code,
            )
        if len(body.metric_names) > cfg.max_query_metrics:
            raise _error(
                422,
                QueryLimitError(f"at most {cfg.max_query_metrics} metrics per query"),
                QueryLimitError.code,
            )
        max_points = min(body.max_points, cfg.max_query_points)
        points = await store.series(
            pr.org_id,
            run_ids=body.run_ids,
            metric_names=body.metric_names,
            step_min=body.step_min,
            step_max=body.step_max,
            max_points=max_points,
        )
        series: dict[tuple[str, str], list[SeriesPointOut]] = {}
        for p in points:
            series.setdefault((p.run_id, p.metric_name), []).append(
                SeriesPointOut(
                    step=p.step,
                    value=p.value,
                    value_min=p.value_min,
                    value_max=p.value_max,
                    ts=p.ts,
                )
            )
        return [
            MetricSeriesOut(run_id=run_id, metric_name=metric, points=pts)
            for (run_id, metric), pts in sorted(series.items())
        ]

    @app.post("/api/v1/query/latest", response_model=list[LatestMetricOut])
    async def query_latest(
        body: MetricsQueryIn,
        pr: WaddlePrincipal = Depends(principal),
    ) -> list[LatestMetricOut]:
        require_role(pr, WaddleRole.READER)
        if len(body.run_ids) > cfg.max_query_runs:
            raise _error(
                422,
                QueryLimitError(f"at most {cfg.max_query_runs} runs per query"),
                QueryLimitError.code,
            )
        rows = await store.latest(pr.org_id, run_ids=body.run_ids)
        return [
            LatestMetricOut(
                run_id=r.run_id, metric_name=r.metric_name, value=r.value, step=r.step, ts=r.ts
            )
            for r in rows
        ]

    @app.get("/api/v1/runs/{run_id}/logs", response_model=list[LogLineOut])
    async def run_logs(
        run_id: str,
        after_ts: datetime | None = None,
        limit: int = Query(default=500, ge=1, le=5000),
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> list[LogLineOut]:
        require_role(pr, WaddleRole.READER)
        await _run_or_404(c, pr, run_id)
        lines = await store.logs_tail(pr.org_id, run_id=run_id, after_ts=after_ts, limit=limit)
        return [
            LogLineOut(ts=line.ts, level=line.level, source=line.source, message=line.message)
            for line in lines
        ]

    @app.post("/api/v1/query/sql", response_model=SqlResultOut)
    async def query_sql(
        body: SqlQueryIn,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> SqlResultOut:
        """Arbitrary DuckDB SQL over the org's own data (views: runs, metrics,
        logs) — isolation by construction in the sqlbox, never by WHERE clause."""
        require_role(pr, WaddleRole.READER)
        try:
            result = await sqlbox.run_sql(
                c, blobs, pr.org_id, sql=body.sql, max_rows=body.max_rows
            )
        except SqlSandboxError as err:
            raise HTTPException(
                422, ErrorOut(code=f"sql_{err.kind}", message=str(err)).model_dump()
            ) from err
        return SqlResultOut(columns=result.columns, rows=result.rows, truncated=result.truncated)

    # ── artifacts ────────────────────────────────────────────────────────────

    @app.post("/api/v1/artifacts/upload-sessions", response_model=UploadSessionOut)
    async def create_upload_session(
        body: CreateUploadSessionIn,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> UploadSessionOut:
        require_role(pr, WaddleRole.WRITER)
        targets: list[UploadTargetOut] = []
        for file in body.files:
            key = blob_key(pr.org_id, file.sha256)
            already = blobs.head(key)
            targets.append(
                UploadTargetOut(
                    logical_path=file.logical_path,
                    sha256=file.sha256,
                    # Within-org dedup: an existing blob needs no upload. Never
                    # consult other orgs' prefixes — existence must not leak.
                    url=None if already is not None else blobs.presign_put(key),
                )
            )
        session = await artifacts.create_upload_session(
            c,
            pr.org_id,
            [file.model_dump() for file in body.files],
            ttl_s=cfg.upload_session_ttl_s,
        )
        return UploadSessionOut(
            session_id=session.id, expires_at=session.expires_at, targets=targets
        )

    def _version_out(
        pr: WaddlePrincipal, version: artifacts.VersionRow, files: list[artifacts.FileRow]
    ) -> ArtifactVersionOut:
        return ArtifactVersionOut(
            id=version.id,
            collection=version.collection_name,
            version=version.version_number,
            digest=version.digest,
            metadata=version.metadata,
            created_by_run_id=version.created_by_run_id,
            created_at=version.created_at,
            files=[
                ArtifactFileOut(
                    logical_path=f.logical_path,
                    sha256=f.blob_sha256,
                    size_bytes=f.size_bytes,
                    media_type=f.media_type,
                    download_url=blobs.presign_get(f.r2_key),
                )
                for f in files
            ],
        )

    @app.post(
        "/api/v1/artifacts/upload-sessions/{session_id}/commit",
        response_model=ArtifactVersionOut,
        status_code=201,
    )
    async def commit_artifact(
        session_id: str,
        body: CommitArtifactIn,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> ArtifactVersionOut:
        require_role(pr, WaddleRole.WRITER)
        session = await artifacts.get_upload_session(c, pr.org_id, _uuid_or_404(session_id))
        if session is None or session.state == "expired":
            raise HTTPException(404, "no open upload session")
        if session.state == "committed":
            raise HTTPException(409, "upload session already committed")

        # Every declared blob must exist with the declared size before anything
        # is committed; deep digest verification is the worker's sampling sweep.
        manifest: dict[str, object] = {}
        file_rows: list[tuple[str, str, str, int, str | None]] = []
        for declared in session.files:
            sha = str(declared["sha256"])
            path = str(declared["logical_path"])
            size = int(str(declared["size_bytes"]))
            key = blob_key(pr.org_id, sha)
            head = blobs.head(key)
            if head is None:
                raise HTTPException(409, f"blob {sha[:12]}… was never uploaded")
            if head.size_bytes != size:
                raise HTTPException(409, f"blob {sha[:12]}… size mismatch")
            manifest[path] = sha
            media_type = declared.get("media_type")
            file_rows.append(
                (path, sha, key, size, str(media_type) if media_type is not None else None)
            )
        digest = hashlib.sha256(
            "\n".join(f"{path}\0{sha}" for path, sha in sorted(manifest.items())).encode()
        ).hexdigest()

        if body.run_id is not None and await repo.get_run(c, pr.org_id, body.run_id) is None:
            raise _error(404, RunNotFoundError(body.run_id), RunNotFoundError.code)
        project = await repo.ensure_project(c, pr.org_id, body.project)
        collection = await artifacts.ensure_collection(
            c, pr.org_id, project.id, body.collection, body.kind.value
        )
        try:
            version = await artifacts.commit_version(
                c,
                pr.org_id,
                collection,
                digest=digest,
                metadata=body.metadata,
                manifest=manifest,
                created_by_run_id=body.run_id,
                files=file_rows,
            )
        except artifacts.ArtifactConflictError as err:
            raise HTTPException(
                409, ErrorOut(code="artifact_digest_exists", message=str(err)).model_dump()
            ) from err
        if body.run_id is not None:
            await artifacts.record_lineage(c, pr.org_id, body.run_id, version.id, body.relation)
        await artifacts.mark_session(c, session.id, "committed")
        got = await artifacts.get_version(c, pr.org_id, version.id)
        assert got is not None
        return _version_out(pr, got[0], got[1])

    @app.get("/api/v1/artifacts/{artifact_id}", response_model=ArtifactVersionOut)
    async def get_artifact(
        artifact_id: str,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> ArtifactVersionOut:
        require_role(pr, WaddleRole.READER)
        got = await artifacts.get_version(c, pr.org_id, _uuid_or_404(artifact_id))
        if got is None:
            raise HTTPException(404, "no such artifact")
        return _version_out(pr, got[0], got[1])

    @app.post("/api/v1/artifacts/{artifact_id}/aliases", status_code=204)
    async def set_artifact_alias(
        artifact_id: str,
        body: AliasIn,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> None:
        require_role(pr, WaddleRole.WRITER)
        got = await artifacts.get_version(c, pr.org_id, _uuid_or_404(artifact_id))
        if got is None:
            raise HTTPException(404, "no such artifact")
        await artifacts.set_alias(c, got[0].collection_id, body.alias, got[0].id)

    @app.get("/api/v1/runs/{run_id}/lineage", response_model=list[RunLineageOut])
    async def get_run_lineage(
        run_id: str,
        c: AsyncConnection[Any] = Depends(conn),
        pr: WaddlePrincipal = Depends(principal),
    ) -> list[RunLineageOut]:
        require_role(pr, WaddleRole.READER)
        await _run_or_404(c, pr, run_id)
        rows = await artifacts.run_lineage(c, pr.org_id, run_id)
        return [
            RunLineageOut(
                run_id=row.run_id,
                relation=row.relation,
                collection=row.collection_name,
                version=row.version_number,
                artifact_id=row.artifact_version_id,
            )
            for row in rows
        ]

    _mount_spa(app, cfg)
    return app


def _uuid_or_404(value: str) -> UUID:
    try:
        return UUID(value)
    except ValueError as err:
        raise HTTPException(404, "no such resource") from err


def _mount_spa(app: FastAPI, cfg: WaddleSettings) -> None:
    dist = cfg.ui_dist
    if dist is None or not dist.is_dir():
        return
    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        candidate = dist / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(dist / "index.html")
