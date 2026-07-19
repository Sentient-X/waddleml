"""The agent SQL surface: full DuckDB expressiveness, org-jailed by construction.

Isolation is structural, never a WHERE clause: the parent stages exactly the
requesting org's Parquet subtree (plus a fresh runs snapshot from Postgres)
into a scratch directory, and a fresh subprocess builds views over those local
files, then disables **and locks** external access before the user's SQL runs.
The query can express anything DuckDB can — it simply has nothing else to read.
Resource ceilings: rlimits in the child (CPU, address space), a wall-clock kill
from the parent, and a row cap on results.

Every dataset a producer has exported under ``orgs/{org}/parquet/`` becomes a
view (the open substrate contract: the compactor writes metrics/logs/runs;
the datasets door accepts e.g. factory_orders); ``runs`` is always the fresh
Postgres snapshot. One job may carry many named queries (a report render) —
they share the staging and the jail, and succeed or fail independently.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from waddle_server.errors import SqlSandboxError
from waddle_server.model import ColumnType
from waddle_server.server.storage import (
    DATASET_NAME_RE,
    ObjectInfo,
    ObjectStore,
    write_parquet,
)
from waddle_server.worker.compact import RUN_COLUMNS

WALL_TIMEOUT_S = 30.0
CPU_LIMIT_S = 25
MEMORY_LIMIT_BYTES = 1 << 31  # 2 GiB address space for the child


class StagingCache:
    """Content-addressed local cache for the org Parquet the sandbox stages.

    Keyed by ``(object key, ETag)``: a replaced snapshot changes its ETag and
    refetches; an unchanged one is a hardlink, so back-to-back queries and
    report renders stop re-downloading the substrate from the object store.
    Bounded by LRU-on-mtime pruning; the cache never holds the only copy of
    anything (the object store is the truth), so eviction is always safe.
    """

    def __init__(self, root: Path, max_bytes: int) -> None:
        self._root = root
        self._max_bytes = max_bytes
        root.mkdir(parents=True, exist_ok=True)

    def fetch(self, store: ObjectStore, obj: ObjectInfo) -> Path:
        digest = hashlib.sha256(f"{obj.key}@{obj.etag}".encode()).hexdigest()
        path = self._root / digest
        if path.exists():
            path.touch()  # LRU recency
            return path
        tmp = self._root / f"{digest}.tmp{os.getpid()}"
        tmp.write_bytes(store.get_bytes(obj.key))
        tmp.replace(path)  # atomic under concurrent fetches of the same object
        self._prune()
        return path

    def _prune(self) -> None:
        blobs = [p for p in self._root.iterdir() if p.is_file() and ".tmp" not in p.name]
        total = sum(p.stat().st_size for p in blobs)
        for path in sorted(blobs, key=lambda p: p.stat().st_mtime):
            if total <= self._max_bytes:
                break
            total -= path.stat().st_size
            path.unlink(missing_ok=True)


def _place(source: Path, dest: Path) -> None:
    """Hardlink a cached blob into the scratch jail (copy when linking can't)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, dest)
    except OSError:
        shutil.copy2(source, dest)


@dataclass(frozen=True, slots=True)
class SqlResult:
    columns: list[str]
    column_types: list[ColumnType]
    rows: list[list[Any]]
    truncated: bool


@dataclass(frozen=True, slots=True)
class QueryFailure:
    kind: str
    message: str


async def run_queries(
    conn: AsyncConnection[Any],
    store: ObjectStore,
    org_id: UUID,
    *,
    queries: dict[str, str],
    max_rows: int,
    cache: StagingCache | None = None,
) -> dict[str, SqlResult | QueryFailure]:
    """Stage the org's data once, run every named query in one jailed child.
    Whole-batch failures (timeout, crash) raise; per-query SQL errors come
    back as QueryFailure so a report can render its healthy panels."""
    with tempfile.TemporaryDirectory(prefix="waddle-sqlbox-") as scratch_str:
        scratch = Path(scratch_str)
        datasets = await _stage_org_data(conn, store, org_id, scratch, cache)
        spec = json.dumps(
            {
                "datasets": {name: [str(p) for p in paths] for name, paths in datasets.items()},
                "scratch": str(scratch),
                "queries": queries,
                "max_rows": max_rows,
                "cpu_limit_s": CPU_LIMIT_S,
                "memory_limit_bytes": MEMORY_LIMIT_BYTES,
            }
        ).encode()
        child = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "waddle_server.sqlbox.child",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                child.communicate(spec), timeout=WALL_TIMEOUT_S
            )
        except TimeoutError as err:
            child.kill()
            await child.wait()
            raise SqlSandboxError("timeout", f"query exceeded {WALL_TIMEOUT_S:.0f}s") from err
    if child.returncode != 0:
        raise SqlSandboxError("crashed", (stderr or b"sandbox died")[-2000:].decode(errors="replace"))
    payload = json.loads(stdout)
    outcomes: dict[str, SqlResult | QueryFailure] = {}
    for name, result in payload["results"].items():
        error = result.get("error")
        if error is not None:
            outcomes[name] = QueryFailure(kind=str(error["code"]), message=str(error["message"]))
        else:
            outcomes[name] = SqlResult(
                columns=result["columns"],
                column_types=[ColumnType(t) for t in result["column_types"]],
                rows=result["rows"],
                truncated=result["truncated"],
            )
    return outcomes


async def run_sql(
    conn: AsyncConnection[Any],
    store: ObjectStore,
    org_id: UUID,
    *,
    sql: str,
    max_rows: int,
    cache: StagingCache | None = None,
) -> SqlResult:
    outcome = (
        await run_queries(
            conn, store, org_id, queries={"query": sql}, max_rows=max_rows, cache=cache
        )
    )["query"]
    if isinstance(outcome, QueryFailure):
        raise SqlSandboxError(outcome.kind, outcome.message)
    return outcome


async def _stage_org_data(
    conn: AsyncConnection[Any],
    store: ObjectStore,
    org_id: UUID,
    scratch: Path,
    cache: StagingCache | None,
) -> dict[str, list[Path]]:
    """Stage the org's Parquet subtree + write a fresh runs snapshot.

    The staged file set IS the security boundary: nothing outside
    ``orgs/{org_id}/parquet/`` is ever touched, and the child never sees a
    credential or a URL. With a cache, unchanged objects are hardlinks."""
    datasets: dict[str, list[Path]] = {}
    prefix = f"orgs/{org_id}/parquet/"
    for obj in store.list_objects(prefix):
        dataset = obj.key[len(prefix) :].split("/", 1)[0]
        # `runs` is always the fresher Postgres snapshot below; a name that
        # fails the dataset law never becomes a view (it would be spliced into
        # the child's CREATE VIEW statement).
        if dataset == "runs" or DATASET_NAME_RE.fullmatch(dataset) is None:
            continue
        dest = scratch / dataset / obj.key.rsplit("/", 1)[-1]
        if cache is not None:
            _place(cache.fetch(store, obj), dest)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(store.get_bytes(obj.key))
        datasets.setdefault(dataset, []).append(dest)

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
    runs_path = scratch / "runs" / "snapshot.parquet"
    runs_path.parent.mkdir(parents=True, exist_ok=True)
    write_parquet([tuple(row) for row in runs], RUN_COLUMNS, runs_path)
    datasets["runs"] = [runs_path]
    return datasets
