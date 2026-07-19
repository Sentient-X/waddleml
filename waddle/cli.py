#!/usr/bin/env python3
"""Waddle CLI: init, ls, sync."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

GITIGNORE_LINES = [".waddle/"]
SYNC_ENVIRONMENT_KEYS = frozenset(
    {
        "hostname",
        "os",
        "python_version",
        "executable",
        "command",
        "cwd",
        "cpu_count",
        "gpu",
        "git_remote",
        "git_branch",
        "git_commit",
        "git_dirty",
    }
)


class SyncSpoolError(Exception):
    """A local run cannot be reconstructed for hosted backfill."""


# ---------- init ----------


def cmd_init(a: argparse.Namespace) -> int:
    root = Path(a.path or ".").resolve()
    waddle_dir = root / ".waddle"
    waddle_dir.mkdir(parents=True, exist_ok=True)
    print(f"created {waddle_dir}/")

    gi = root / ".gitignore"
    txt = gi.read_text(encoding="utf-8") if gi.exists() else ""
    changed = False
    for line in GITIGNORE_LINES:
        if line not in txt:
            txt += "\n" + line
            changed = True
    if changed:
        gi.write_text(txt + "\n", encoding="utf-8")
        print(f"updated {gi}")

    print("initialized .waddle/")
    return 0


# ---------- ls ----------


def cmd_ls(a: argparse.Namespace) -> int:
    db_path = _find_db(a.db)
    if not db_path:
        print("no .waddle/waddle.duckdb found", file=sys.stderr)
        return 1

    import duckdb

    conn = duckdb.connect(db_path, read_only=True)
    try:
        limit = a.limit or 20
        sql = "SELECT id, project, name, status, started_at, ended_at, commit_sha FROM runs ORDER BY started_at DESC LIMIT $1"
        rows = conn.execute(sql, [limit]).fetchall()
        if not rows:
            print("no runs found")
            return 0

        print(
            f"{'ID':>8}  {'Project':<15} {'Name':<20} {'Status':<10} {'Duration':>10} {'Commit':>8}"
        )
        print("-" * 85)
        for row in rows:
            rid, project, name, status, started, ended, commit = row
            duration = ""
            if started and ended:
                secs = ended - started
                duration = f"{secs:.1f}s" if secs < 60 else f"{secs / 60:.1f}m"
            elif started:
                duration = "running"
            commit_str = (commit or "")[:8]
            print(
                f"{rid[:8]}  {(project or ''):<15} {(name or ''):<20} {(status or ''):<10} {duration:>10} {commit_str:>8}"
            )
    finally:
        conn.close()
    return 0


# ---------- sync ----------


def cmd_sync(a: argparse.Namespace) -> int:
    """Backfill a spool DB to the hosted platform (robot nodes that trained
    offline). Uses the same engine as live sync, so replays stay idempotent."""
    from ._db import WaddleDB
    from ._run import RESEARCH_CONFIG_KEY
    from ._sync import SyncConfig, SyncEngine

    config = SyncConfig.from_env()
    if config is None:
        print(
            "WADDLE_API_URL must be set (plus WADDLE_API_KEY outside the "
            "auth-optional dev server).",
            file=sys.stderr,
        )
        return 1
    db_path = _find_db(a.db)
    if not db_path:
        print("no waddle.duckdb found. pass --db <path>.", file=sys.stderr)
        return 1
    db = WaddleDB(db_path)
    try:
        rows = db.fetchall(
            "SELECT id, project, name, status, started_at, commit_sha, config,"
            " env, group_name, job_type FROM runs"
            + (" WHERE id = $1" if a.run else ""),
            [a.run] if a.run else None,
        )
        if not rows:
            print("no matching runs in the spool", file=sys.stderr)
            return 1
        for (
            run_id,
            project,
            name,
            status,
            started_at,
            commit_sha,
            config_json,
            environment_json,
            group_name,
            job_type,
        ) in rows:
            import json as _json

            config_dict = _json.loads(config_json or "{}")
            environment_dict = _json.loads(environment_json or "{}")
            if not isinstance(config_dict, dict):
                raise SyncSpoolError(f"run {run_id} config is not an object")
            if not isinstance(environment_dict, dict):
                raise SyncSpoolError(f"run {run_id} environment is not an object")
            environment_dict = {
                key: value
                for key, value in environment_dict.items()
                if key in SYNC_ENVIRONMENT_KEYS
            }
            research_dict = config_dict.pop(RESEARCH_CONFIG_KEY, None)
            if research_dict is not None and not isinstance(research_dict, dict):
                raise SyncSpoolError(f"run {run_id} research record is not an object")
            engine = SyncEngine(
                db,
                config,
                run_id=run_id,
                project=project or "default",
                name=name or run_id[:8],
                config_dict=config_dict,
                group_name=group_name,
                job_type=job_type,
                research_dict=research_dict,
                commit_sha=commit_sha,
                started_at=started_at,
                resume=False,
                rank=0,
                local_rank=0,
                world_size=1,
                node_id="backfill",
                attempt=0,
                environment=environment_dict,
                start_thread=False,
            )
            engine.drain_once()
            if status in {"completed", "failed", "aborted"}:
                engine.finish_once(status)
            print(f"synced {run_id[:8]} ({project}/{name}, {status})")
    finally:
        db.close()
    return 0


# ---------- helpers ----------


def _find_db(explicit: str | None = None) -> str | None:
    """Find the DuckDB file: explicit path, then cwd, then walk up to the git root."""
    if explicit and Path(explicit).exists():
        return str(Path(explicit).resolve())

    local = Path.cwd() / ".waddle" / "waddle.duckdb"
    if local.exists():
        return str(local)

    p = Path.cwd()
    for _ in range(10):
        candidate = p / ".waddle" / "waddle.duckdb"
        if candidate.exists():
            return str(candidate)
        parent = p.parent
        if parent == p:
            break
        p = parent

    return None


# ---------- parser ----------


def build() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="waddle", description="WaddleML: local experiment tracker"
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("init", help="Initialize .waddle/ directory")
    pi.add_argument("--path", help="project root (default: cwd)")
    pi.set_defaults(func=cmd_init)

    pl = sub.add_parser("ls", help="List recent runs")
    pl.add_argument("--db", help="path to waddle.duckdb")
    pl.add_argument("-n", "--limit", type=int, default=20, help="max runs to show")
    pl.set_defaults(func=cmd_ls)

    ps = sub.add_parser("sync", help="Backfill a spool DB to the hosted platform")
    ps.add_argument("--db", help="path to waddle.duckdb (default: nearest .waddle/)")
    ps.add_argument("--run", help="sync only this run id")
    ps.set_defaults(func=cmd_sync)

    return p


def main(argv: list[str] | None = None) -> int:
    argv = argv or sys.argv[1:]
    args = build().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
