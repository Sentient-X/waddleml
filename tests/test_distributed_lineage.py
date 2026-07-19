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
