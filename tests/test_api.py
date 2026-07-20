"""Tests for the wandb-style Python API (waddle.init / waddle.log / waddle.finish)."""

import json
import os
import subprocess
from pathlib import Path

import pytest

import waddle
from waddle import (
    ResearchDecision,
    ResearchGoal,
    ResearchOutcome,
    ResearchTrial,
    ResearchTrialError,
    RunType,
    RunTypeError,
)
from waddle._db import WaddleDB
from waddle import _state


def _init_git_repo(base: Path) -> Path:
    repo_path = base / "repo"
    repo_path.mkdir()
    subprocess.run(
        ["git", "init"],
        cwd=repo_path,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    subprocess.run(
        ["git", "config", "user.email", "waddle@example.com"],
        cwd=repo_path,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    subprocess.run(
        ["git", "config", "user.name", "Waddle Tester"],
        cwd=repo_path,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    (repo_path / "train.py").write_text("print('hello')\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", "."],
        cwd=repo_path,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    subprocess.run(
        ["git", "commit", "-m", "initial"],
        cwd=repo_path,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return repo_path


@pytest.fixture(autouse=True)
def _cleanup_state():
    """Reset global state after each test."""
    yield
    _state.set_active_run(None)


def test_init_and_log_with_git(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo_path = _init_git_repo(tmp_path)
    monkeypatch.chdir(repo_path)

    run = waddle.init(
        project="test-project",
        name="run-1",
        config={"lr": 0.01, "epochs": 100},
        tags={"model": "resnet"},
        system_metrics=False,
    )
    assert run is not None
    assert run.commit_sha is not None  # git detected
    assert _state.get_active_run() is run

    waddle.log({"loss": 0.5, "acc": 0.9}, step=0)
    waddle.log({"loss": 0.3, "acc": 0.95})  # auto-increments step

    waddle.finish()
    assert _state.get_active_run() is None

    db = run._db
    run_row = db.fetchone(
        "SELECT project, name, status, commit_sha FROM runs WHERE id = $1", [run.id]
    )
    assert run_row[0] == "test-project"
    assert run_row[1] == "run-1"
    assert run_row[2] == "completed"
    assert run_row[3] is not None

    param = db.fetchone(
        "SELECT value FROM params WHERE run_id = $1 AND key = 'lr'", [run.id]
    )
    assert json.loads(param[0]) == 0.01

    tag = db.fetchone(
        "SELECT value FROM tags WHERE run_id = $1 AND key = 'model'", [run.id]
    )
    assert json.loads(tag[0]) == "resnet"

    metrics = db.fetchall(
        "SELECT key, step, value FROM metrics WHERE run_id = $1 ORDER BY step", [run.id]
    )
    assert len(metrics) == 4
    loss_rows = [m for m in metrics if m[0] == "loss"]
    assert loss_rows[0][2] == pytest.approx(0.5)
    assert loss_rows[1][2] == pytest.approx(0.3)


def test_init_without_git(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """waddle.init() should work in a directory that is NOT a git repo."""
    no_git_dir = tmp_path / "no_git"
    no_git_dir.mkdir()
    monkeypatch.chdir(no_git_dir)

    run = waddle.init(project="no-git", name="run-nogit", system_metrics=False)
    assert run is not None
    assert run.commit_sha is None  # no git

    waddle.log({"loss": 0.42})
    waddle.finish()

    db = run._db
    run_row = db.fetchone(
        "SELECT project, name, status, repo_id, commit_sha FROM runs WHERE id = $1",
        [run.id],
    )
    assert run_row[0] == "no-git"
    assert run_row[1] == "run-nogit"
    assert run_row[2] == "completed"
    assert run_row[3] is None
    assert run_row[4] is None

    metric = db.fetchone(
        "SELECT value FROM metrics WHERE run_id = $1 AND key = 'loss'", [run.id]
    )
    assert metric[0] == pytest.approx(0.42)


def test_context_manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo_path = _init_git_repo(tmp_path)
    monkeypatch.chdir(repo_path)

    with waddle.init(project="ctx", system_metrics=False) as run:
        waddle.log({"loss": 1.0})
        run_id = run.id

    assert _state.get_active_run() is None
    db_path = os.path.join(str(repo_path), ".waddle", "waddle.duckdb")
    db = WaddleDB(db_path)
    row = db.fetchone("SELECT status FROM runs WHERE id = $1", [run_id])
    assert row[0] == "completed"


def test_context_manager_on_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo_path = _init_git_repo(tmp_path)
    monkeypatch.chdir(repo_path)

    with pytest.raises(ValueError):
        with waddle.init(project="err", system_metrics=False) as run:
            run_id = run.id
            raise ValueError("boom")

    db_path = os.path.join(str(repo_path), ".waddle", "waddle.duckdb")
    db = WaddleDB(db_path)
    row = db.fetchone("SELECT status FROM runs WHERE id = $1", [run_id])
    assert row[0] == "failed"


def test_context_manager_without_git(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Context manager works without git too."""
    no_git = tmp_path / "nogit"
    no_git.mkdir()
    monkeypatch.chdir(no_git)

    with waddle.init(project="nogit-ctx", system_metrics=False) as run:
        waddle.log({"x": 1.0})
        run_id = run.id

    assert _state.get_active_run() is None
    db = run._db
    row = db.fetchone("SELECT status FROM runs WHERE id = $1", [run_id])
    assert row[0] == "completed"


def test_log_artifact(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo_path = _init_git_repo(tmp_path)
    monkeypatch.chdir(repo_path)
    artifact_file = repo_path / "model.pt"
    artifact_file.write_bytes(b"model weights")

    run = waddle.init(project="art", system_metrics=False)
    aid = waddle.log_artifact("model.pt", str(artifact_file), kind="model", inline=True)
    waddle.finish()

    db = run._db
    row = db.fetchone(
        "SELECT name, kind, size_bytes, relation FROM artifacts WHERE id = $1",
        [aid],
    )
    assert row == ("model.pt", "model", len(b"model weights"), "output")


def test_use_artifact_records_input_edge(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    no_git = tmp_path / "nogit"
    no_git.mkdir()
    monkeypatch.chdir(no_git)
    checkpoint = no_git / "base.safetensors"
    checkpoint.write_bytes(b"base weights")

    run = waddle.init(project="art", system_metrics=False)
    aid = waddle.use_artifact("base.safetensors", str(checkpoint), kind="model")
    waddle.finish()

    row = run._db.fetchone(
        "SELECT name, kind, relation, size_bytes FROM artifacts WHERE id = $1", [aid]
    )
    assert row == ("base.safetensors", "model", "input", len(b"base weights"))


def test_log_without_init_raises():
    _state.set_active_run(None)
    with pytest.raises(RuntimeError, match="No active run"):
        waddle.log({"loss": 0.5})


def test_research_trial_uses_normal_run_and_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    no_git = tmp_path / "nogit"
    no_git.mkdir()
    monkeypatch.chdir(no_git)
    db_path = no_git / "research.duckdb"

    root = waddle.init(
        project="edge-inference",
        name="baseline",
        db_path=str(db_path),
        research=ResearchTrial(
            campaign="m10-5090",
            trial_index=0,
            objective_name="latency/p99_ms",
            goal=ResearchGoal.MINIMIZE,
            hypothesis="native baseline",
            session_name="overnight-sm120",
        ),
        system_metrics=False,
    )
    waddle.log({"latency/p99_ms": 25.0}, step=0)
    waddle.finish()

    child = waddle.init(
        project="edge-inference",
        name="static-buffers",
        db_path=str(db_path),
        research=ResearchTrial(
            campaign="m10-5090",
            trial_index=1,
            objective_name="latency/p99_ms",
            goal=ResearchGoal.MINIMIZE,
            hypothesis="static buffers remove allocation overhead",
            session_name="overnight-sm120",
            parent_run_id=root.id,
            subject_run_id=root.id,
        ),
        system_metrics=False,
    )
    waddle.log({"latency/p99_ms": 22.0}, step=0)
    waddle.finish()

    rows = child._db.fetchall(
        "SELECT run_id, group_name, job_type FROM evidence_runs ORDER BY started_at"
    )
    assert rows == [
        (root.id, "m10-5090", "autoresearch"),
        (child.id, "m10-5090", "autoresearch"),
    ]
    config = child._db.fetchone("SELECT config FROM runs WHERE id = $1", [child.id])
    research = json.loads(config[0])["_waddle_research"]
    assert research == {
        "goal": "minimize",
        "hypothesis": "static buffers remove allocation overhead",
        "objective_name": "latency/p99_ms",
        "parent_run_id": root.id,
        "session_name": "overnight-sm120",
        "subject_run_id": root.id,
        "trial_index": 1,
    }


def test_research_record_rejects_reserved_config_and_invalid_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ResearchTrialError, match="trial_index"):
        ResearchTrial(
            campaign="m10",
            trial_index=-1,
            objective_name="latency_ms",
            goal=ResearchGoal.MINIMIZE,
            hypothesis="invalid",
        )

    with pytest.raises(ResearchTrialError, match="session_name"):
        ResearchTrial(
            campaign="m10",
            trial_index=0,
            objective_name="latency_ms",
            goal=ResearchGoal.MINIMIZE,
            hypothesis="invalid",
            session_name=" ",
        )

    with pytest.raises(ResearchTrialError, match="subject_run_id"):
        ResearchTrial(
            campaign="m10",
            trial_index=0,
            objective_name="latency_ms",
            goal=ResearchGoal.MINIMIZE,
            hypothesis="invalid",
            subject_run_id=" ",
        )

    with pytest.raises(ResearchTrialError, match="reserved"):
        waddle.init(
            db_path=str(tmp_path / "research.duckdb"),
            config={"_waddle_research": {}},
            system_metrics=False,
        )


def test_typed_run_metadata_is_durable_and_research_identity_is_unambiguous(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.chdir(tmp_path)
    run = waddle.init(
        db_path=str(tmp_path / "typed.duckdb"),
        run_type=RunType.TRAINING,
        group_name="libero-finetune",
        system_metrics=False,
    )
    row = run._db.fetchone("SELECT job_type, group_name FROM runs WHERE id = $1", [run.id])
    assert row == ("training", "libero-finetune")
    run.finish()

    with pytest.raises(RunTypeError, match="AUTORESEARCH"):
        waddle.init(
            db_path=str(tmp_path / "invalid.duckdb"),
            run_type=RunType.AUTORESEARCH,
            system_metrics=False,
        )

    evaluation = waddle.init(
        db_path=str(tmp_path / "evaluation-research.duckdb"),
        run_type=RunType.EVALUATION,
        research=ResearchTrial(
            campaign="m10-quality",
            trial_index=0,
            objective_name="quality/success_rate",
            goal=ResearchGoal.MAXIMIZE,
            hypothesis="evaluate the optimized policy",
        ),
        system_metrics=False,
    )
    assert evaluation._db.fetchone(
        "SELECT job_type, group_name FROM runs WHERE id = $1", [evaluation.id]
    ) == ("evaluation", "m10-quality")
    evaluation.finish()


def test_research_proposal_and_outcome_are_durable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.chdir(tmp_path)
    run = waddle.init(
        db_path=str(tmp_path / "research-outcome.duckdb"),
        research=ResearchTrial(
            campaign="m10",
            trial_index=1,
            objective_name="latency/p99_ms",
            goal=ResearchGoal.MINIMIZE,
            hypothesis="fuse the epilogue",
            rationale="the trace shows three launch-bound elementwise kernels",
            expected_outcome="p99 falls by at least 2% with unchanged actions",
            falsification_criteria="any correctness gate fails or p99 improves by less than 2%",
        ),
        system_metrics=False,
    )
    run.log({"latency/p99_ms": 20.0})
    run.finish(
        research_outcome=ResearchOutcome(
            decision=ResearchDecision.KEEP,
            evidence="p99 improved 3.1%; all registered correctness gates passed",
            conclusion="the fused epilogue removes measurable launch overhead",
            next_step="confirm in three clean processes",
        )
    )

    config_json, outcome_json = run._db.fetchone(
        "SELECT config, research_outcome FROM runs WHERE id = $1", [run.id]
    )
    proposal = json.loads(config_json)["_waddle_research"]
    outcome = json.loads(outcome_json)
    assert proposal["rationale"].startswith("the trace")
    assert proposal["expected_outcome"].startswith("p99 falls")
    assert proposal["falsification_criteria"].startswith("any correctness")
    assert outcome == {
        "conclusion": "the fused epilogue removes measurable launch overhead",
        "decision": "keep",
        "evidence": "p99 improved 3.1%; all registered correctness gates passed",
        "failed_gates": [],
        "next_step": "confirm in three clean processes",
    }


def test_ordinary_run_rejects_research_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.chdir(tmp_path)
    run = waddle.init(db_path=str(tmp_path / "ordinary.duckdb"), system_metrics=False)
    with pytest.raises(ResearchTrialError, match="requires a research trial"):
        run.finish(
            research_outcome=ResearchOutcome(
                decision=ResearchDecision.INCONCLUSIVE,
                evidence="no research contract exists",
                conclusion="this is an ordinary run",
            )
        )
    run.finish()


def test_research_session_preserves_legacy_positional_parent() -> None:
    parent_run_id = "a" * 32
    trial = ResearchTrial(
        "m10",
        1,
        "latency_ms",
        ResearchGoal.MINIMIZE,
        "legacy positional call",
        parent_run_id,
    )

    assert trial.parent_run_id == parent_run_id
    assert trial.session_name is None
    assert trial.subject_run_id is None


def test_research_identity_is_immutable_on_resume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.chdir(tmp_path)
    db_path = tmp_path / "research.duckdb"
    run_id = "a" * 32
    root = ResearchTrial(
        campaign="m10",
        trial_index=0,
        objective_name="latency_ms",
        goal=ResearchGoal.MINIMIZE,
        hypothesis="baseline",
    )
    waddle.init(
        db_path=str(db_path),
        run_id=run_id,
        research=root,
        system_metrics=False,
    ).finish()

    with pytest.raises(ResearchTrialError, match="immutable"):
        waddle.init(
            db_path=str(db_path),
            run_id=run_id,
            research=ResearchTrial(
                campaign="m10",
                trial_index=0,
                objective_name="throughput",
                goal=ResearchGoal.MAXIMIZE,
                hypothesis="changed",
            ),
            resume=True,
            system_metrics=False,
        )


def test_log_param_and_tag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    no_git = tmp_path / "nogit"
    no_git.mkdir()
    monkeypatch.chdir(no_git)

    run = waddle.init(project="pt", system_metrics=False)
    waddle.log_param("batch_size", 32)
    waddle.log_tag("experiment", "baseline")
    waddle.finish()

    db = run._db
    p = db.fetchone(
        "SELECT value FROM params WHERE run_id = $1 AND key = 'batch_size'", [run.id]
    )
    assert json.loads(p[0]) == 32
    t = db.fetchone(
        "SELECT value FROM tags WHERE run_id = $1 AND key = 'experiment'", [run.id]
    )
    assert json.loads(t[0]) == "baseline"


def test_init_duplicate_run_id_without_resume_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    no_git_dir = tmp_path / "no_git"
    no_git_dir.mkdir()
    monkeypatch.chdir(no_git_dir)

    waddle.init(project="dup", run_id="run-1", system_metrics=False)
    waddle.finish()

    import duckdb

    with pytest.raises(duckdb.ConstraintException):
        waddle.init(project="dup", run_id="run-1", system_metrics=False)


def test_init_resume_reopens_run_as_new_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """resume=True continues an existing run id: one run row, next attempt."""
    no_git_dir = tmp_path / "no_git"
    no_git_dir.mkdir()
    monkeypatch.chdir(no_git_dir)

    waddle.init(
        project="res", run_id="run-1", config={"lr": 0.01}, system_metrics=False
    )
    waddle.log({"loss": 1.0}, step=0)
    waddle.finish()

    resumed = waddle.init(
        project="res",
        run_id="run-1",
        config={"lr": 0.01},
        system_metrics=False,
        resume=True,
    )
    db = resumed._db
    row = db.fetchone("SELECT status, ended_at FROM runs WHERE id = $1", ["run-1"])
    assert row[0] == "running"
    assert row[1] is None

    waddle.log({"loss": 0.5}, step=1)
    waddle.finish()

    assert db.fetchone("SELECT count(*) FROM runs WHERE id = $1", ["run-1"])[0] == 1
    attempts = [
        r[0]
        for r in db.fetchall(
            "SELECT attempt FROM run_workers WHERE run_id = $1 ORDER BY attempt",
            ["run-1"],
        )
    ]
    assert attempts == [0, 1]
    metric_attempts = [
        r[0]
        for r in db.fetchall(
            "SELECT attempt FROM metrics WHERE run_id = $1 AND key = 'loss' ORDER BY step",
            ["run-1"],
        )
    ]
    assert metric_attempts == [0, 1]
