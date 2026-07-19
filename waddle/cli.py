#!/usr/bin/env python3
"""Waddle CLI: init, ls, dashboard.

`dashboard` launches the Evidence.dev dashboard (packages/waddleml/evidence/)
against a snapshot of a run's DuckDB, refreshed on an interval so the dashboard
tracks a running job without ever contending for DuckDB's single-writer lock.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import threading
from pathlib import Path

GITIGNORE_LINES = [".waddle/"]


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

        print(f"{'ID':>8}  {'Project':<15} {'Name':<20} {'Status':<10} {'Duration':>10} {'Commit':>8}")
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
            print(f"{rid[:8]}  {(project or ''):<15} {(name or ''):<20} {(status or ''):<10} {duration:>10} {commit_str:>8}")
    finally:
        conn.close()
    return 0


# ---------- dashboard ----------

def cmd_dashboard(a: argparse.Namespace) -> int:
    db_path = _find_db(a.db)
    if not db_path:
        print("no waddle.duckdb found. run a training script with waddle.init() first, "
              "or pass --db <path>.", file=sys.stderr)
        return 1
    live = Path(db_path)

    evidence_dir = Path(a.evidence_dir) if a.evidence_dir else _evidence_dir()
    if not (evidence_dir / "package.json").exists():
        print(f"Evidence project not found at {evidence_dir}. The dashboard ships with the "
              "waddleml source tree; run from a checkout or pass --evidence-dir.", file=sys.stderr)
        return 1

    npm = shutil.which("npm")
    if npm is None:
        print("npm not found. The Evidence dashboard needs Node.js (>=18).", file=sys.stderr)
        return 1

    if not (evidence_dir / "node_modules").exists():
        if a.no_install:
            print(f"dependencies not installed. run `npm install` in {evidence_dir}.", file=sys.stderr)
            return 1
        print(f"[waddle] installing dashboard dependencies in {evidence_dir} (first run only)…")
        if subprocess.run([npm, "install"], cwd=evidence_dir).returncode != 0:
            print("npm install failed.", file=sys.stderr)
            return 1

    snapshot = evidence_dir / "sources" / "waddle" / "waddle.duckdb"
    _snapshot_db(live, snapshot)
    _ensure_views(snapshot)
    print(f"[waddle] dashboard for {live}")
    print(f"[waddle] snapshot -> {snapshot} (refresh every {a.refresh}s)")
    # Run sources once up front so the first page load is already fresh instead of
    # waiting out the first refresh interval.
    subprocess.run([npm, "run", "sources"], cwd=evidence_dir, capture_output=True)

    stop = threading.Event()
    watcher = threading.Thread(
        target=_refresh_loop, args=(live, snapshot, evidence_dir, npm, a.refresh, stop), daemon=True
    )
    watcher.start()

    proc = subprocess.Popen(
        [npm, "run", "dev", "--", "--port", str(a.port), "--host", a.host],
        cwd=evidence_dir,
    )
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
    finally:
        stop.set()
    return proc.returncode or 0


def _snapshot_db(live: Path, dest: Path) -> None:
    """Copy the live DB (and its WAL) so Evidence reads a consistent, lock-free copy.

    DuckDB replays a copied .wal on open, so copying both files captures state up
    to the last flushed write even while training holds the file open.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(live, dest)
    live_wal = Path(str(live) + ".wal")
    dest_wal = Path(str(dest) + ".wal")
    if live_wal.exists():
        shutil.copy2(live_wal, dest_wal)
    elif dest_wal.exists():
        dest_wal.unlink()


def _ensure_views(snapshot: Path) -> None:
    """Apply the current schema (idempotent) to the snapshot so the evidence_*
    views exist even for DBs written by an older waddle. Safe: the snapshot is our
    private copy, so this write never contends with the live training process."""
    import duckdb

    from ._schema import SCHEMA_DDL

    conn = duckdb.connect(str(snapshot))
    try:
        conn.execute(SCHEMA_DDL)
    finally:
        conn.close()


def _refresh_loop(
    live: Path, dest: Path, evidence_dir: Path, npm: str, interval: float, stop: threading.Event
) -> None:
    last_mtime: float | None = None
    while not stop.wait(interval):
        try:
            mtime = live.stat().st_mtime
        except OSError:
            continue
        if mtime == last_mtime:
            continue
        last_mtime = mtime
        _snapshot_db(live, dest)
        _ensure_views(dest)
        subprocess.run([npm, "run", "sources"], cwd=evidence_dir, capture_output=True)


# ---------- sync ----------

def cmd_sync(a: argparse.Namespace) -> int:
    """Backfill a spool DB to the hosted platform (robot nodes that trained
    offline). Uses the same engine as live sync, so replays stay idempotent."""
    from ._db import WaddleDB
    from ._sync import SyncConfig, SyncEngine

    config = SyncConfig.from_env()
    if config is None:
        print("WADDLE_API_URL and WADDLE_API_KEY must be set.", file=sys.stderr)
        return 1
    db_path = _find_db(a.db)
    if not db_path:
        print("no waddle.duckdb found. pass --db <path>.", file=sys.stderr)
        return 1
    db = WaddleDB(db_path)
    try:
        rows = db.fetchall(
            "SELECT id, project, name, status, started_at, commit_sha, config FROM runs"
            + (" WHERE id = $1" if a.run else ""),
            [a.run] if a.run else None,
        )
        if not rows:
            print("no matching runs in the spool", file=sys.stderr)
            return 1
        for run_id, project, name, status, started_at, commit_sha, config_json in rows:
            import json as _json

            engine = SyncEngine(
                db,
                config,
                run_id=run_id,
                project=project or "default",
                name=name or run_id[:8],
                config_dict=_json.loads(config_json or "{}"),
                commit_sha=commit_sha,
                started_at=started_at,
                resume=False,
                rank=0, local_rank=0, world_size=1, node_id="backfill", attempt=0,
                start_thread=False,
            )
            engine.drain_once()
            print(f"synced {run_id[:8]} ({project}/{name}, {status})")
    finally:
        db.close()
    return 0


# ---------- helpers ----------

def _evidence_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "evidence"


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
    p = argparse.ArgumentParser(prog="waddle", description="WaddleML: local experiment tracker")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("init", help="Initialize .waddle/ directory")
    pi.add_argument("--path", help="project root (default: cwd)")
    pi.set_defaults(func=cmd_init)

    pl = sub.add_parser("ls", help="List recent runs")
    pl.add_argument("--db", help="path to waddle.duckdb")
    pl.add_argument("-n", "--limit", type=int, default=20, help="max runs to show")
    pl.set_defaults(func=cmd_ls)

    pd = sub.add_parser("dashboard", help="Launch the Evidence.dev dashboard")
    pd.add_argument("--db", help="path to waddle.duckdb (default: nearest .waddle/)")
    pd.add_argument("--host", default="localhost")
    pd.add_argument("--port", type=int, default=3000)
    pd.add_argument("--refresh", type=float, default=30.0, help="snapshot refresh interval, seconds")
    pd.add_argument("--evidence-dir", help="override the Evidence project location")
    pd.add_argument("--no-install", action="store_true", help="fail instead of running npm install")
    pd.set_defaults(func=cmd_dashboard)

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
