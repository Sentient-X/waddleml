"""Distributed identity and immutable source observation."""

import subprocess

import duckdb

import waddle
from waddle import WorkerInfo
from waddle import WaddleDB


def test_metrics_carry_worker_and_lineage(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    db_path = tmp_path / "runs.duckdb"
    worker = WorkerInfo(
        rank=3, local_rank=1, world_size=8, node_id="trainer-b", attempt=2
    )

    run = waddle.init(
        project="distributed",
        db_path=str(db_path),
        run_id="run-1",
        worker=worker,
        lineage={"dataset_ref": "catalog://datasets/umi@sha256:abc"},
        system_metrics=False,
    )
    run.log({"loss": 0.5}, step=4)
    run.finish()

    conn = duckdb.connect(str(db_path))
    assert conn.execute(
        "SELECT rank, node_id, attempt FROM evidence_run_metrics"
    ).fetchone() == (3, "trainer-b", 2)
    assert conn.execute(
        "SELECT lineage->>'dataset_ref' FROM runs WHERE id = 'run-1'"
    ).fetchone() == ("catalog://datasets/umi@sha256:abc",)


def test_init_observes_dirty_git_tree_without_committing(tmp_path, monkeypatch):
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"], cwd=tmp_path, check=True
    )
    subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, check=True)
    source = tmp_path / "source.py"
    source.write_text("value = 1\n")
    subprocess.run(["git", "add", "source.py"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "commit", "-m", "initial"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )
    source.write_text("value = 2\n")
    before = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True
    )
    monkeypatch.chdir(tmp_path)

    run = waddle.init(system_metrics=False)
    run.finish()

    after = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True
    )
    assert after == before
    conn = duckdb.connect(str(tmp_path / ".waddle" / "waddle.duckdb"))
    digest = conn.execute(
        "SELECT lineage->>'source_patch_sha256' FROM runs"
    ).fetchone()[0]
    assert len(digest) == 64


def test_existing_database_is_migrated_in_place(tmp_path):
    path = tmp_path / "old.duckdb"
    conn = duckdb.connect(str(path))
    conn.execute(
        """CREATE TABLE runs (
           id VARCHAR PRIMARY KEY, project VARCHAR, name VARCHAR, status VARCHAR,
           started_at DOUBLE, ended_at DOUBLE, config JSON)"""
    )
    conn.execute(
        "CREATE TABLE metrics (run_id VARCHAR, key VARCHAR, step INTEGER, ts DOUBLE, value DOUBLE)"
    )
    conn.close()

    db = WaddleDB(str(path))
    run_columns = {row[1] for row in db.fetchall("PRAGMA table_info('runs')")}
    metric_columns = {row[1] for row in db.fetchall("PRAGMA table_info('metrics')")}
    assert "lineage" in run_columns
    assert {"group_name", "job_type"} <= run_columns
    assert {"rank", "node_id", "attempt"} <= metric_columns


def test_metric_latest_view_dedups_attempts_and_spans_extremes(tmp_path, monkeypatch):
    """evidence_run_metric_latest: per step the latest attempt wins; `value` is
    the last step's value; min/max span the deduplicated stream."""
    monkeypatch.chdir(tmp_path)
    db_path = tmp_path / "runs.duckdb"

    run = waddle.init(
        project="latest", db_path=str(db_path), run_id="run-1", system_metrics=False
    )
    for step, value in enumerate([1.0, 0.8, 0.6, 0.4]):
        run.log({"loss": value}, step=step)
    run.finish()

    # Resume from step 2's checkpoint: attempt 1 rewrites steps 2-3.
    resumed = waddle.init(
        project="latest",
        db_path=str(db_path),
        run_id="run-1",
        resume=True,
        system_metrics=False,
    )
    resumed.log({"loss": 9.0}, step=2)
    resumed.log({"loss": 0.2}, step=3)
    resumed.finish()

    conn = duckdb.connect(str(db_path))
    row = conn.execute(
        "SELECT value, step, value_min, value_max FROM evidence_run_metric_latest"
        " WHERE run_id = 'run-1' AND key = 'loss'"
    ).fetchone()
    assert row == (0.2, 3, 0.2, 9.0)


def test_views_keep_ranks_as_distinct_series(tmp_path, monkeypatch):
    """A second rank logging the same key never smears into rank 0's series:
    the decimated, system, and latest views all partition by rank."""
    monkeypatch.chdir(tmp_path)
    db_path = tmp_path / "runs.duckdb"
    run = waddle.init(
        project="ranks", db_path=str(db_path), run_id="run-1", system_metrics=False
    )
    for step in range(4):
        run.log({"loss": 1.0 / (step + 1)}, step=step)
        run.log_metric("system/gpu0_util_percent", step, 50.0)
    run.finish()
    # Rank 1's rows arrive in the same spool (e.g. an analysis DB merging
    # per-rank spool files).
    for step in range(4):
        run._db.execute(
            "INSERT INTO metrics (run_id, key, step, ts, value, rank, node_id, attempt)"
            " VALUES ('run-1', 'loss', $1, $2, 7.0, 1, 'node1', 0)",
            [step, 1_753_000_000.0 + step],
        )

    conn = duckdb.connect(str(db_path))
    latest = conn.execute(
        "SELECT rank, value, value_max FROM evidence_run_metric_latest"
        " WHERE run_id = 'run-1' AND key = 'loss' ORDER BY rank"
    ).fetchall()
    assert latest == [(0, 0.25, 1.0), (1, 7.0, 7.0)]
    ds_ranks = conn.execute(
        "SELECT DISTINCT rank FROM evidence_run_metrics_ds"
        " WHERE run_id = 'run-1' AND key = 'loss' ORDER BY rank"
    ).fetchall()
    assert ds_ranks == [(0,), (1,)]
    sys_ranks = conn.execute(
        "SELECT DISTINCT rank FROM evidence_system_metrics WHERE run_id = 'run-1'"
    ).fetchall()
    assert sys_ranks == [(0,)]
