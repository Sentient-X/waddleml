"""The agent SQL surface: full DuckDB expressiveness, org-jailed by construction.

Isolation is structural, never a WHERE clause: the parent stages exactly the
requesting org's Parquet subtree (plus a fresh runs snapshot from Postgres)
into a scratch directory, and a fresh subprocess builds views over those local
files, then disables **and locks** external access before the user's SQL runs.
The query can express anything DuckDB can — it simply has nothing else to read.
Resource ceilings: rlimits in the child (CPU, address space), a wall-clock kill
from the parent, and a row cap on results.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from waddle_server.errors import SqlSandboxError
from waddle_server.server.storage import ObjectStore
from waddle_server.worker.compact import RUN_COLUMNS, _write_parquet

WALL_TIMEOUT_S = 30.0
CPU_LIMIT_S = 25
MEMORY_LIMIT_BYTES = 1 << 31  # 2 GiB address space for the child


@dataclass(frozen=True, slots=True)
class SqlResult:
    columns: list[str]
    rows: list[list[Any]]
    truncated: bool


async def run_sql(
    conn: AsyncConnection[Any],
    store: ObjectStore,
    org_id: UUID,
    *,
    sql: str,
    max_rows: int,
) -> SqlResult:
    with tempfile.TemporaryDirectory(prefix="waddle-sqlbox-") as scratch_str:
        scratch = Path(scratch_str)
        datasets = await _stage_org_data(conn, store, org_id, scratch)
        spec = json.dumps(
            {
                "datasets": {name: [str(p) for p in paths] for name, paths in datasets.items()},
                "scratch": str(scratch),
                "sql": sql,
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
        try:
            error = json.loads(stdout or b"{}").get("error")
        except json.JSONDecodeError:
            error = None
        if isinstance(error, dict):
            raise SqlSandboxError(str(error.get("code", "query_failed")), str(error.get("message")))
        raise SqlSandboxError("crashed", (stderr or b"sandbox died")[-2000:].decode(errors="replace"))
    result = json.loads(stdout)
    return SqlResult(
        columns=result["columns"], rows=result["rows"], truncated=result["truncated"]
    )


async def _stage_org_data(
    conn: AsyncConnection[Any], store: ObjectStore, org_id: UUID, scratch: Path
) -> dict[str, list[Path]]:
    """Download the org's Parquet subtree + write a fresh runs snapshot.

    The staged file set IS the security boundary: nothing outside
    ``orgs/{org_id}/parquet/`` is ever touched, and the child never sees a
    credential or a URL."""
    datasets: dict[str, list[Path]] = {"metrics": [], "logs": [], "runs": []}
    prefix = f"orgs/{org_id}/parquet/"
    for key in store.list_keys(prefix):
        dataset = key[len(prefix) :].split("/", 1)[0]
        if dataset not in ("metrics", "logs"):
            continue  # runs snapshot below is fresher than the worker's export
        dest = scratch / dataset / key.rsplit("/", 1)[-1]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(store.get_bytes(key))
        datasets[dataset].append(dest)

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
    _write_parquet([tuple(row) for row in runs], RUN_COLUMNS, runs_path)
    datasets["runs"].append(runs_path)
    return datasets
