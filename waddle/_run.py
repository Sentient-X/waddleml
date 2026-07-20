"""Run class with metric batching, context manager, and atexit support."""

from __future__ import annotations

import atexit
import hashlib
import json
import logging
import os
import sys
import threading
import time
import uuid
from dataclasses import replace
from typing import Any, Dict, Optional

from ._db import WaddleDB
from ._sync import SyncConfig, SyncEngine
from ._types import (
    ResearchOutcome,
    ResearchTrial,
    ResearchTrialError,
    RunType,
    RunTypeError,
    WorkerInfo,
)

RESEARCH_CONFIG_KEY = "_waddle_research"
RESEARCH_JOB_TYPE = RunType.AUTORESEARCH.value


#: python logging levelno → the platform's four wire levels
def _wire_level(levelno: int) -> str:
    if levelno >= logging.ERROR:
        return "error"
    if levelno >= logging.WARNING:
        return "warning"
    if levelno >= logging.INFO:
        return "info"
    return "debug"


class _LogCaptureHandler(logging.Handler):
    """Root-logger observer feeding ``Run.log_line``. Purely additive to the
    user's logging tree (never mutates levels or other handlers) and never
    raises into training; a re-entrant emit (something inside our own write
    path logging) is dropped instead of recursing."""

    def __init__(self, run: "Run") -> None:
        super().__init__(logging.DEBUG)
        self._run = run
        self._guard = threading.local()

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(self._guard, "busy", False):
            return
        self._guard.busy = True
        try:
            self._run.log_line(
                record.getMessage(),
                level=_wire_level(record.levelno),
                source=record.name,
            )
        except Exception:
            pass
        finally:
            self._guard.busy = False


class Run:
    def __init__(
        self,
        db: WaddleDB,
        run_id: str,
        project: str,
        name: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        tags: Optional[Dict[str, Any]] = None,
        repo_id: Optional[str] = None,
        commit_sha: Optional[str] = None,
        system_metrics: bool = True,
        worker: WorkerInfo = WorkerInfo(),
        lineage: Optional[Dict[str, str]] = None,
        research: Optional[ResearchTrial] = None,
        run_type: Optional[RunType] = None,
        group_name: Optional[str] = None,
        resume: bool = False,
        sync: Optional[bool] = None,
        environment: Optional[Dict[str, Any]] = None,
        capture_logging: bool = True,
    ):
        # resume=True reopens an existing run id (e.g. continuing from a
        # checkpoint after a crash): the run row is upserted back to running
        # and this process gets the next free attempt number, so the metrics
        # of every attempt stay distinguishable.
        if resume:
            row = db.fetchone(
                "SELECT COALESCE(MAX(attempt) + 1, 0) FROM run_workers"
                " WHERE run_id = $1 AND rank = $2",
                [run_id, worker.rank],
            )
            next_attempt = row[0] if row and row[0] is not None else 0
            if next_attempt > worker.attempt:
                worker = replace(worker, attempt=next_attempt)
        self._db = db
        self.id = run_id
        self.project = project
        self.name = name or run_id[:8]
        self.commit_sha = commit_sha
        self._step = 0
        self._finished = False
        self._worker = worker
        self._is_research = research is not None
        self._sysmon: Any = None

        # create run record; `environment` (built by init) is the reproduce-
        # this-run superset — the legacy keys stay for old spool readers
        env = {
            "python": sys.version,
            "platform": sys.platform,
            "cwd": os.getcwd(),
            "argv": sys.argv,
            **(environment or {}),
        }
        self._environment = dict(environment or {})
        config_dict = dict(config or {})
        if RESEARCH_CONFIG_KEY in config_dict:
            raise ResearchTrialError(
                f"{RESEARCH_CONFIG_KEY!r} is reserved; pass research=ResearchTrial(...)"
            )
        if group_name is not None and not group_name.strip():
            raise RunTypeError("group_name must not be empty when present")
        research_dict: Optional[Dict[str, Any]] = None
        effective_group_name = group_name
        job_type = run_type.value if run_type is not None else None
        if research is not None:
            if run_type is not None and run_type is not RunType.AUTORESEARCH:
                raise RunTypeError("a research trial requires run_type=AUTORESEARCH")
            if group_name is not None and group_name != research.campaign:
                raise RunTypeError("a research trial's group_name must equal its campaign")
            research_dict = {
                "trial_index": research.trial_index,
                "objective_name": research.objective_name,
                "goal": research.goal.value,
                "hypothesis": research.hypothesis,
                "parent_run_id": research.parent_run_id,
            }
            if research.session_name is not None:
                research_dict["session_name"] = research.session_name
            if research.subject_run_id is not None:
                research_dict["subject_run_id"] = research.subject_run_id
            if research.rationale is not None:
                research_dict["rationale"] = research.rationale
            if research.expected_outcome is not None:
                research_dict["expected_outcome"] = research.expected_outcome
            if research.falsification_criteria is not None:
                research_dict["falsification_criteria"] = (
                    research.falsification_criteria
                )
            config_dict[RESEARCH_CONFIG_KEY] = research_dict
            effective_group_name = research.campaign
            job_type = RESEARCH_JOB_TYPE
        elif run_type is RunType.AUTORESEARCH:
            raise RunTypeError("run_type=AUTORESEARCH requires a research trial")
        config_json = json.dumps(config_dict, ensure_ascii=False, sort_keys=True)
        if resume:
            existing = db.fetchone(
                "SELECT group_name, job_type, config FROM runs WHERE id = $1", [run_id]
            )
            if existing is not None and (
                existing[1] == RESEARCH_JOB_TYPE or job_type == RESEARCH_JOB_TYPE
            ):
                existing_config = json.loads(existing[2])
                if (
                    existing[0] != effective_group_name
                    or existing[1] != job_type
                    or existing_config.get(RESEARCH_CONFIG_KEY) != research_dict
                ):
                    raise ResearchTrialError(
                        "a run's research identity is immutable across resumes"
                    )
        env_json = json.dumps(env, ensure_ascii=False, sort_keys=True)
        insert_run = """INSERT INTO runs (id, project, repo_id, commit_sha, name, status,
                                 started_at, env, config, notes, lineage, group_name, job_type)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)"""
        if resume:
            # Keep the original started_at and notes; refresh what describes
            # the current process.
            insert_run += """
               ON CONFLICT (id) DO UPDATE SET
                   status = EXCLUDED.status,
                   ended_at = NULL,
                   commit_sha = EXCLUDED.commit_sha,
                   env = EXCLUDED.env,
                   config = EXCLUDED.config,
                   lineage = EXCLUDED.lineage,
                   group_name = EXCLUDED.group_name,
                   job_type = EXCLUDED.job_type,
                   research_outcome = NULL"""
        db.execute(
            insert_run,
            [
                run_id,
                project,
                repo_id,
                commit_sha,
                self.name,
                "running",
                time.time(),
                env_json,
                config_json,
                None,
                json.dumps(lineage or {}, sort_keys=True),
                effective_group_name,
                job_type,
            ],
        )
        db.execute(
            """INSERT INTO run_workers
               (run_id, rank, local_rank, world_size, node_id, attempt, started_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            [
                run_id,
                worker.rank,
                worker.local_rank,
                worker.world_size,
                worker.node_id,
                worker.attempt,
                time.time(),
            ],
        )

        # log config as params
        if config_dict:
            for k, v in config_dict.items():
                self.log_param(k, v)

        # log tags
        if tags:
            for k, v in tags.items():
                self.log_tag(k, v)

        # start system metrics
        if system_metrics:
            self._start_sysmetrics()

        # Platform sync: on when WADDLE_API_URL/WADDLE_API_KEY are set (sync=None)
        # or forced by sync=True; the engine is offline-first and never raises
        # into training. sync=False keeps a credentialed node local-only.
        self._sync: Any = None
        if sync is not False:
            sync_config = SyncConfig.from_env()
            if sync_config is not None:
                self._sync = SyncEngine(
                    db,
                    sync_config,
                    run_id=run_id,
                    project=project,
                    name=self.name,
                    config_dict=dict(config or {}),
                    group_name=effective_group_name,
                    job_type=job_type,
                    research_dict=research_dict,
                    commit_sha=commit_sha,
                    started_at=time.time(),
                    resume=resume,
                    rank=worker.rank,
                    local_rank=worker.local_rank,
                    world_size=worker.world_size,
                    node_id=worker.node_id,
                    attempt=worker.attempt,
                    environment=self._environment or None,
                )

        # observe the user's logging tree (opt-out via capture_logging=False)
        self._log_handler: Optional[_LogCaptureHandler] = None
        if capture_logging:
            self._log_handler = _LogCaptureHandler(self)
            logging.getLogger().addHandler(self._log_handler)

        # register atexit
        atexit.register(self._atexit)

    def _start_sysmetrics(self) -> None:
        try:
            from ._sysmetrics import SystemMonitor

            self._sysmon = SystemMonitor(self)
            self._sysmon.start()
        except Exception:
            pass

    def _atexit(self) -> None:
        if not self._finished:
            self.finish(status="aborted")

    # ---- logging ----

    def log(self, metrics: Dict[str, float], step: Optional[int] = None) -> None:
        if step is None:
            step = self._step
            self._step += 1
        else:
            self._step = step + 1
        ts = time.time()
        for key, value in metrics.items():
            self._db.execute(
                """INSERT INTO metrics
                   (run_id, key, step, ts, value, rank, node_id, attempt)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                [
                    self.id,
                    key,
                    step,
                    ts,
                    float(value),
                    self._worker.rank,
                    self._worker.node_id,
                    self._worker.attempt,
                ],
            )
        if self._sync is not None:
            self._sync.notify()

    def log_line(self, message: str, level: str = "info", source: str = "") -> None:
        """Spool one console/log line beside the metrics. `level` is clamped to
        the platform's four wire levels; this path never raises into training."""
        if self._finished:
            return
        if level not in ("debug", "info", "warning", "error"):
            level = "info"
        try:
            self._db.execute(
                """INSERT INTO log_lines
                   (run_id, ts, level, source, message, rank, node_id, attempt)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                [
                    self.id,
                    time.time(),
                    level,
                    source,
                    str(message),
                    self._worker.rank,
                    self._worker.node_id,
                    self._worker.attempt,
                ],
            )
            if self._sync is not None:
                self._sync.notify()
        except Exception:
            pass

    def log_param(self, key: str, value: Any) -> None:
        self._db.execute(
            """INSERT INTO params (run_id, key, value) VALUES ($1, $2, $3)
               ON CONFLICT (run_id, key) DO UPDATE SET value = EXCLUDED.value""",
            [self.id, key, json.dumps(value, ensure_ascii=False)],
        )

    def log_tag(self, key: str, value: Any) -> None:
        self._db.execute(
            """INSERT INTO tags (run_id, key, value) VALUES ($1, $2, $3)
               ON CONFLICT (run_id, key) DO UPDATE SET value = EXCLUDED.value""",
            [self.id, key, json.dumps(value, ensure_ascii=False)],
        )

    def log_metric(
        self, key: str, step: int, value: float, ts: Optional[float] = None
    ) -> None:
        if ts is None:
            ts = time.time()
        self._db.execute(
            """INSERT INTO metrics
               (run_id, key, step, ts, value, rank, node_id, attempt)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
            [
                self.id,
                key,
                step,
                ts,
                float(value),
                self._worker.rank,
                self._worker.node_id,
                self._worker.attempt,
            ],
        )
        if self._sync is not None:
            self._sync.notify()

    def log_artifact(
        self,
        name: str,
        path: Optional[str] = None,
        kind: str = "file",
        inline: bool = False,
    ) -> str:
        aid = uuid.uuid4().hex
        created = time.time()
        uri = None
        blob = None
        sha_hex = None
        size = None
        if path:
            uri = os.path.abspath(path)
            with open(path, "rb") as f:
                data = f.read()
            sha_hex = hashlib.sha256(data).hexdigest()
            size = len(data)
            if inline:
                blob = data
        else:
            sha_hex = hashlib.sha256(b"").hexdigest()
        self._db.execute(
            """INSERT INTO artifacts (id, run_id, name, kind, created_at, uri, sha256, size_bytes, inline_bytes)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)""",
            [aid, self.id, name, kind, created, uri, sha_hex, size, blob],
        )
        if self._sync is not None and path and size is not None:
            self._sync.upload_artifact(name, os.path.abspath(path), kind, sha_hex, size)
        return aid

    # ---- lifecycle ----

    def finish(
        self,
        status: str = "completed",
        research_outcome: Optional[ResearchOutcome] = None,
    ) -> None:
        if self._finished:
            return
        if research_outcome is not None and not self._is_research:
            raise ResearchTrialError("research_outcome requires a research trial")
        outcome_dict: Optional[Dict[str, Any]] = None
        if research_outcome is not None:
            outcome_dict = {
                "decision": research_outcome.decision.value,
                "evidence": research_outcome.evidence,
                "conclusion": research_outcome.conclusion,
                "failed_gates": list(research_outcome.failed_gates),
                "next_step": research_outcome.next_step,
            }
        self._finished = True
        if self._log_handler is not None:
            logging.getLogger().removeHandler(self._log_handler)
            self._log_handler = None
        if self._sysmon:
            self._sysmon.stop()
        self._db.execute(
            "UPDATE runs SET status = $1, ended_at = $2, research_outcome = $3 WHERE id = $4",
            [
                status,
                time.time(),
                json.dumps(outcome_dict, ensure_ascii=False, sort_keys=True)
                if outcome_dict is not None
                else None,
                self.id,
            ],
        )
        if self._sync is not None:
            self._sync.finalize(status, research_outcome=outcome_dict)

    # ---- context manager ----

    def __enter__(self) -> Run:
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.finish(status="failed" if exc else "completed")
        from . import _state

        _state.set_active_run(None)
