"""The sandbox child (``python -m waddle_server.sqlbox.child``).

Reads one job spec from stdin, answers one JSON result on stdout, exits. The
security order is load-bearing:

1. rlimits first (CPU seconds, address space) — the process constrains itself
   before touching any input.
2. Views over the staged local Parquet — the only data that exists here.
3. ``allowed_directories = [scratch]`` + ``enable_external_access = false`` then
   ``lock_configuration = true`` — DuckDB can now read the staged directory and
   physically nothing else (no other files, no URLs, no extension
   install/load), and the user's SQL cannot undo any of it.
4. Only then do the job's queries execute, each with a fetch cap. One spec may
   carry many named queries (a report render); they share the staging and the
   jail, and each succeeds or fails independently.
"""

from __future__ import annotations

import json
import resource
import sys
from datetime import date, datetime
from typing import Any

import duckdb

_NUMERIC_MARKS = ("INT", "FLOAT", "DOUBLE", "DECIMAL", "NUMBER", "NUMERIC", "REAL")


def _column_type(type_code: object) -> str:
    """DuckDB's cursor type name → the coarse wire ColumnType vocabulary."""
    name = str(type_code).upper()
    if "BOOL" in name:
        return "boolean"
    if any(mark in name for mark in _NUMERIC_MARKS):
        return "number"
    if "DATE" in name or "TIME" in name:
        return "date"
    return "string"


def _json_safe(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, (int, float, str, bool)) or value is None:
        return value
    return str(value)


def main() -> int:
    spec = json.loads(sys.stdin.buffer.read())
    resource.setrlimit(resource.RLIMIT_CPU, (spec["cpu_limit_s"], spec["cpu_limit_s"]))
    try:
        resource.setrlimit(
            resource.RLIMIT_AS, (spec["memory_limit_bytes"], spec["memory_limit_bytes"])
        )
    except ValueError:  # some platforms (macOS) refuse RLIMIT_AS; DuckDB's own
        pass  # memory_limit below still bounds the query
    conn = duckdb.connect(":memory:")
    conn.execute(f"SET memory_limit = '{spec['memory_limit_bytes'] // (1 << 20)}MB'")
    conn.execute("SET threads = 2")
    for name, paths in spec["datasets"].items():
        if paths:
            # CREATE VIEW cannot be a prepared statement; the paths come from the
            # parent (never the user) and are quoted defensively anyway.
            quoted = ", ".join("'" + p.replace("'", "''") + "'" for p in paths)
            conn.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet([{quoted}])")
        # A dataset with no files yet simply has no view: honest absence beats a
        # fabricated empty schema (SELECTing it errors with "no such table").
    scratch = spec["scratch"].replace("'", "''")
    conn.execute(f"SET allowed_directories = ['{scratch}']")
    conn.execute("SET enable_external_access = false")
    conn.execute("SET lock_configuration = true")

    max_rows = int(spec["max_rows"])
    results: dict[str, Any] = {}
    for name, sql in spec["queries"].items():
        try:
            cursor = conn.execute(sql)
            rows = cursor.fetchmany(max_rows + 1)
            description = cursor.description or []
        except duckdb.Error as error:
            results[name] = {"error": {"code": "query_failed", "message": str(error)}}
            continue
        results[name] = {
            "columns": [d[0] for d in description],
            "column_types": [_column_type(d[1]) for d in description],
            "rows": [[_json_safe(v) for v in row] for row in rows[:max_rows]],
            "truncated": len(rows) > max_rows,
        }
    json.dump({"results": results}, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
