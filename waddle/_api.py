"""Module-level wandb-style API: init, log, finish, log_artifact, use_artifact,
log_param, log_tag."""

from __future__ import annotations

import os
import platform
import shlex
import socket
import sys
import uuid
from typing import Any, Dict, Optional

from ._db import WaddleDB
from ._run import Run
from . import _state
from ._types import ResearchOutcome, ResearchTrial, RunType, WorkerInfo


def _gpu_name() -> Optional[str]:
    try:
        import pynvml  # type: ignore[import-untyped]

        pynvml.nvmlInit()
        count = pynvml.nvmlDeviceGetCount()
        if count == 0:
            return None
        name = pynvml.nvmlDeviceGetName(pynvml.nvmlDeviceGetHandleByIndex(0))
        label = name.decode() if isinstance(name, bytes) else str(name)
        return f"{count}x {label}" if count > 1 else label
    except Exception:
        return None


def _capture_environment(
    repo_root: Optional[str],
    origin: Optional[str],
    branch: Optional[str],
    commit_sha: Optional[str],
    dirty: bool,
) -> Dict[str, Any]:
    """The reproduce-this-run snapshot, taken once at init. Every field is
    best-effort; a missing fact is absent, never a placeholder."""
    env: Dict[str, Any] = {
        "hostname": socket.gethostname(),
        "os": platform.platform(),
        "python_version": platform.python_version(),
        "executable": sys.executable,
        "command": shlex.join(sys.argv),
        "cwd": os.getcwd(),
        "cpu_count": os.cpu_count(),
    }
    gpu = _gpu_name()
    if gpu:
        env["gpu"] = gpu
    if repo_root:
        if origin:
            env["git_remote"] = origin
        if branch:
            env["git_branch"] = branch
        if commit_sha:
            env["git_commit"] = commit_sha
        env["git_dirty"] = dirty
    return env


def init(
    project: str = "default",
    name: Optional[str] = None,
    config: Optional[Dict[str, Any]] = None,
    tags: Optional[Dict[str, Any]] = None,
    db_path: Optional[str] = None,
    system_metrics: bool = True,
    run_id: Optional[str] = None,
    worker: Optional[WorkerInfo] = None,
    lineage: Optional[Dict[str, str]] = None,
    research: Optional[ResearchTrial] = None,
    run_type: Optional[RunType] = None,
    group_name: Optional[str] = None,
    resume: bool = False,
    sync: Optional[bool] = None,
    capture_logging: bool = True,
) -> Run:
    """Initialize a new run.

    Works anywhere. If inside a git repo, automatically captures the commit SHA
    and repo info. If not, the run still works — just without git metadata.
    An environment snapshot (host, python, command, git state) is captured once
    for the run page's reproduce-this-run view.

    Lines emitted through the standard ``logging`` tree are spooled beside the
    metrics (capture_logging=False opts out); ``waddle.log_line`` records a
    line explicitly.

    With resume=True an existing run_id is reopened as a new attempt instead of
    failing on the duplicate id (use when continuing from a checkpoint).

    Platform sync is on by default whenever WADDLE_API_URL and WADDLE_API_KEY
    are set in the environment (sync=False opts out); without them the run is
    purely local, exactly as before.
    """
    repo_id: Optional[str] = None
    commit_sha: Optional[str] = None

    # try to detect git repo (optional)
    from ._git import (
        detect_repo_root,
        get_origin,
        detect_default_branch,
        get_head_sha,
        working_tree_digest,
    )

    repo_root = detect_repo_root(os.getcwd())
    origin: Optional[str] = None
    branch: Optional[str] = None
    dirty_digest: Optional[str] = None

    if repo_root:
        # we're in a git repo — capture info as a bonus
        if db_path is None:
            db_path = os.path.join(repo_root, ".waddle", "waddle.duckdb")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        db = WaddleDB(db_path)

        origin = get_origin(repo_root)
        branch = detect_default_branch(repo_root)
        repo_name = os.path.basename(repo_root)
        repo = db.upsert_repo(repo_name, repo_root, origin, branch)
        repo_id = repo.id

        commit_sha = get_head_sha(repo_root)
        if commit_sha:
            db.record_commit(repo.id, commit_sha, repo_root)
        dirty_digest = working_tree_digest(repo_root)
        if dirty_digest:
            lineage = {**(lineage or {}), "source_patch_sha256": dirty_digest}
    else:
        # no git — just use a local .waddle/ in cwd
        if db_path is None:
            db_path = os.path.join(os.getcwd(), ".waddle", "waddle.duckdb")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        db = WaddleDB(db_path)

    run_id = run_id or uuid.uuid4().hex
    worker = worker or WorkerInfo(node_id=socket.gethostname())
    run = Run(
        db=db,
        run_id=run_id,
        project=project,
        name=name,
        config=config,
        tags=tags,
        repo_id=repo_id,
        commit_sha=commit_sha,
        system_metrics=system_metrics,
        worker=worker,
        lineage=lineage,
        research=research,
        run_type=run_type,
        group_name=group_name,
        resume=resume,
        sync=sync,
        environment=_capture_environment(
            repo_root, origin, branch, commit_sha, dirty_digest is not None
        ),
        capture_logging=capture_logging,
    )
    _state.set_active_run(run)
    return run


def log(metrics: Dict[str, float], step: Optional[int] = None) -> None:
    """Log metrics to the active run."""
    run = _state.get_active_run()
    if run is None:
        raise RuntimeError("No active run. Call waddle.init() first.")
    run.log(metrics, step=step)


def log_param(key: str, value: Any) -> None:
    run = _state.get_active_run()
    if run is None:
        raise RuntimeError("No active run. Call waddle.init() first.")
    run.log_param(key, value)


def log_tag(key: str, value: Any) -> None:
    run = _state.get_active_run()
    if run is None:
        raise RuntimeError("No active run. Call waddle.init() first.")
    run.log_tag(key, value)


def log_line(message: str, level: str = "info", source: str = "") -> None:
    """Record one log line on the active run (no-op without one — safe to call
    from library code)."""
    run = _state.get_active_run()
    if run is not None:
        run.log_line(message, level=level, source=source)


def log_artifact(
    name: str, path: Optional[str] = None, kind: str = "file", inline: bool = False
) -> str:
    run = _state.get_active_run()
    if run is None:
        raise RuntimeError("No active run. Call waddle.init() first.")
    return run.log_artifact(name, path, kind, inline)


def use_artifact(name: str, path: str, kind: str = "file") -> str:
    """Record an artifact the active run consumed (an input lineage edge)."""
    run = _state.get_active_run()
    if run is None:
        raise RuntimeError("No active run. Call waddle.init() first.")
    return run.use_artifact(name, path, kind)


def finish(research_outcome: Optional[ResearchOutcome] = None) -> None:
    """Finish the active run."""
    run = _state.get_active_run()
    if run is None:
        return
    run.finish(research_outcome=research_outcome)
    _state.set_active_run(None)
