"""Background sync to the hosted waddle platform.

Offline-first by construction: the local DuckDB **is** the durable spool — this
engine only ever reads what `Run.log()` already wrote and remembers how far it
got. Delivery is at-least-once with exactly-once *logical* ingestion:

- Outgoing batches are persisted (``sync_outbox``, exact payload bytes) before
  the first send, so a crash-recovery resend is byte-identical and the server's
  batch ledger + ClickHouse block dedup absorb it.
- A per-run cursor (``sync_cursor``) tracks the last spool row drained into a
  batch; the stored ``writer_id`` identifies the spool file across process
  restarts, keeping sequence numbers monotone (server-side gap detection stays
  meaningful).
- Batches group consecutive rows by ``(rank, node_id, attempt)`` so
  crash-recovery backfill of an earlier attempt's rows keeps its labels.

The engine runs on its own DuckDB cursor (transaction scope separate from the
training thread's inserts) and serializes its own work with a mutex. Network
failures never block ``log()`` and never raise into the training process: rows
accumulate in the spool and the uploader retries with capped exponential
backoff. No env vars set → the engine is never constructed and the SDK behaves
exactly as before.
"""

from __future__ import annotations

import gzip
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from ._types import ArtifactRelation

if TYPE_CHECKING:
    from ._db import WaddleDB

FLUSH_INTERVAL_S = 1.0
MAX_POINTS_PER_BATCH = 5000
GZIP_THRESHOLD_BYTES = 4096
BACKOFF_MAX_S = 60.0


class SyncStateError(Exception):
    """A synchronous backfill received an unsupported terminal state."""


SYNC_DDL = """\
CREATE TABLE IF NOT EXISTS sync_cursor (
    run_id VARCHAR PRIMARY KEY,
    writer_id VARCHAR NOT NULL,
    last_rowid BIGINT NOT NULL,
    next_sequence BIGINT NOT NULL,
    last_log_rowid BIGINT NOT NULL DEFAULT -1
);

ALTER TABLE sync_cursor ADD COLUMN IF NOT EXISTS last_log_rowid BIGINT DEFAULT -1;

CREATE TABLE IF NOT EXISTS sync_outbox (
    batch_id VARCHAR PRIMARY KEY,
    run_id VARCHAR NOT NULL,
    sequence_start BIGINT NOT NULL,
    sequence_end BIGINT NOT NULL,
    payload BLOB NOT NULL,
    created_at DOUBLE NOT NULL
);
"""


@dataclass(frozen=True)
class SyncConfig:
    api_url: str
    # Empty = no credential sent: works against a dev server in auth-optional
    # mode (runs land in its dev org); a prod server rejects with 401 and the
    # engine keeps spooling — fail closed, nothing lost.
    api_key: str = ""
    project_override: Optional[str] = None

    @staticmethod
    def from_env() -> Optional["SyncConfig"]:
        url = os.environ.get("WADDLE_API_URL")
        if not url:
            return None
        return SyncConfig(
            api_url=url.rstrip("/"),
            api_key=os.environ.get("WADDLE_API_KEY", ""),
            project_override=os.environ.get("WADDLE_PROJECT") or None,
        )


class SyncEngine:
    """One uploader per run; background-facing methods never raise."""

    def __init__(
        self,
        db: "WaddleDB",
        config: SyncConfig,
        *,
        run_id: str,
        project: str,
        name: str,
        config_dict: Dict[str, Any],
        commit_sha: Optional[str],
        started_at: float,
        resume: bool,
        rank: int,
        local_rank: int,
        world_size: int,
        node_id: str,
        attempt: int,
        group_name: Optional[str] = None,
        job_type: Optional[str] = None,
        research_dict: Optional[Dict[str, Any]] = None,
        environment: Optional[Dict[str, Any]] = None,
        start_thread: bool = True,
    ) -> None:
        self._config = config
        self._run_id = run_id
        self._project = config.project_override or project
        self._name = name
        self._config_dict = config_dict
        self._group_name = group_name
        self._job_type = job_type
        self._research_dict = research_dict
        self._environment = environment
        self._commit_sha = commit_sha
        self._started_at = started_at
        self._resume = resume
        self._worker = (rank, local_rank, world_size, node_id, attempt)
        for stmt in SYNC_DDL.strip().split(";"):
            if stmt.strip():
                db.execute(stmt)
        self._conn = db.cursor()  # own transaction scope; guarded by _mutex
        self._mutex = threading.Lock()
        self._artifacts: List[Tuple[str, str, str, str, int, ArtifactRelation]] = []
        self._artifacts_lock = threading.Lock()
        self._writer_id = self._load_writer_id()
        self._run_registered = False
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._backoff = 1.0
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="waddle-sync"
        )
        if start_thread:
            self._thread.start()

    def drain_once(self) -> None:
        """Synchronous register + full drain; raises on failure (`waddle sync`)."""
        with self._mutex:
            self._ensure_run_registered()
            self._drain(deadline=None)

    def finish_once(
        self, state: str, research_outcome: Optional[Dict[str, Any]] = None
    ) -> None:
        """Synchronously mirror one terminal spool state; raises on failure."""
        if state not in {"completed", "failed", "aborted"}:
            raise SyncStateError(f"unsupported terminal run state {state!r}")
        body: Dict[str, Any] = {"state": state}
        if research_outcome is not None:
            body["research_outcome"] = research_outcome
        self._post_json(f"/api/v1/runs/{self._run_id}/finish", body)

    def upload_artifact(
        self,
        name: str,
        path: str,
        kind: str,
        sha256: str,
        size_bytes: int,
        relation: ArtifactRelation,
    ) -> None:
        """Queue one file artifact for background upload (never raises)."""
        with self._artifacts_lock:
            self._artifacts.append((name, path, kind, sha256, size_bytes, relation))
        self._wake.set()

    # ---- Run-facing API (never raises) ----

    def notify(self) -> None:
        """Called after log(); wakes the uploader early when a lot is pending."""
        self._wake.set()

    def finalize(
        self,
        state: str,
        timeout_s: float = 5.0,
        research_outcome: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Final drain + best-effort run finish; bounded so shutdown never hangs."""
        deadline = time.time() + timeout_s
        self._stop.set()
        self._wake.set()
        if self._thread.is_alive():
            self._thread.join(timeout=max(0.1, deadline - time.time()))
        try:
            with self._mutex:
                self._ensure_run_registered()
                self._drain(deadline=deadline)
            body: Dict[str, Any] = {"state": state}
            if research_outcome is not None:
                body["research_outcome"] = research_outcome
            self._post_json(f"/api/v1/runs/{self._run_id}/finish", body)
        except Exception:
            pass  # spool keeps the truth; `waddle sync` can deliver later

    # ---- the uploader ----

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(timeout=FLUSH_INTERVAL_S)
            self._wake.clear()
            try:
                with self._mutex:
                    self._ensure_run_registered()
                    self._drain(deadline=None)
                self._backoff = 1.0
            except Exception:
                # Network/server trouble: leave everything in the spool and back off.
                self._stop.wait(timeout=self._backoff)
                self._backoff = min(self._backoff * 2, BACKOFF_MAX_S)

    def _load_writer_id(self) -> str:
        self._conn.execute(
            "INSERT INTO sync_cursor (run_id, writer_id, last_rowid, next_sequence)"
            " VALUES ($1, $2, -1, 0) ON CONFLICT DO NOTHING",
            [self._run_id, str(uuid.uuid4())],
        )
        row = self._conn.execute(
            "SELECT writer_id FROM sync_cursor WHERE run_id = $1", [self._run_id]
        ).fetchone()
        assert row is not None
        return str(row[0])

    def _ensure_run_registered(self) -> None:
        if self._run_registered:
            return
        rank, local_rank, world_size, node_id, attempt = self._worker
        self._post_json(
            "/api/v1/runs",
            {
                "run_id": self._run_id,
                "project": self._project,
                "name": self._name,
                "group_name": self._group_name,
                "job_type": self._job_type,
                "research": self._research_dict,
                "config": self._config_dict,
                "commit_sha": self._commit_sha,
                "environment": self._environment,
                "started_at": _iso(self._started_at),
                "resume": self._resume,
                "worker": {
                    "rank": rank,
                    "local_rank": local_rank,
                    "world_size": world_size,
                    "node_id": node_id,
                    "attempt": attempt,
                    "writer_id": self._writer_id,
                },
            },
        )
        self._run_registered = True

    def _drain(self, deadline: Optional[float]) -> None:
        """Resend unacked outbox batches, then turn new spool rows into batches."""
        for batch_id, payload in self._pending_outbox():
            self._send_batch(batch_id, payload)
        while deadline is None or time.time() < deadline:
            batch = self._build_batch()
            if batch is None:
                break
            batch_id, payload = batch
            self._send_batch(batch_id, payload)
        self._drain_artifacts()

    def _drain_artifacts(self) -> None:
        while True:
            with self._artifacts_lock:
                if not self._artifacts:
                    return
                name, path, kind, sha256, size_bytes, relation = self._artifacts[0]
            self._upload_one_artifact(name, path, kind, sha256, size_bytes, relation)
            with self._artifacts_lock:
                self._artifacts.pop(0)

    def _upload_one_artifact(
        self,
        name: str,
        path: str,
        kind: str,
        sha256: str,
        size_bytes: int,
        relation: ArtifactRelation,
    ) -> None:
        session = self._request_json(
            "POST",
            "/api/v1/artifacts/upload-sessions",
            body=json.dumps(
                {
                    "files": [
                        {
                            "logical_path": os.path.basename(path),
                            "sha256": sha256,
                            "size_bytes": size_bytes,
                        }
                    ]
                },
                ensure_ascii=False,
            ).encode(),
            headers={"content-type": "application/json"},
        )
        target = session["targets"][0]
        if target["url"] is not None:  # None = org already holds this blob
            with open(path, "rb") as blob:
                data = blob.read()
            put = urllib.request.Request(target["url"], data=data, method="PUT")
            with urllib.request.urlopen(put, timeout=300):
                pass
        commit = {
            "collection": name,
            "project": self._project,
            "kind": kind if kind in ("model", "dataset", "media") else "file",
            "run_id": self._run_id,
            "relation": relation.value,
        }
        try:
            self._request_json(
                "POST",
                f"/api/v1/artifacts/upload-sessions/{session['session_id']}/commit",
                body=json.dumps(commit, ensure_ascii=False).encode(),
                headers={"content-type": "application/json"},
            )
        except urllib.error.HTTPError as error:
            # 409 = unretryable session/blob conflict (identical content is NOT
            # a conflict — the server reuses the version and still records the
            # edge); retrying forever would wedge the queue, so drop and move on.
            if error.code != 409:
                raise

    def _pending_outbox(self) -> List[Tuple[str, bytes]]:
        rows = self._conn.execute(
            "SELECT batch_id, payload FROM sync_outbox WHERE run_id = $1"
            " ORDER BY sequence_start",
            [self._run_id],
        ).fetchall()
        return [(str(r[0]), bytes(r[1])) for r in rows]

    def _build_batch(self) -> Optional[Tuple[str, bytes]]:
        """Move the next slice of spool rows into one persisted outbox batch —
        metrics first; once the metric stream is drained, log lines. Both share
        one monotone sequence via ``sync_cursor``.

        Consecutive rows are grouped by (rank, node_id, attempt) — one batch per
        homogeneous prefix — so a backfill of an earlier attempt keeps its labels.
        """
        cursor = self._conn.execute(
            "SELECT last_rowid, next_sequence,"
            " COALESCE(last_log_rowid, -1) FROM sync_cursor WHERE run_id = $1",
            [self._run_id],
        ).fetchone()
        assert cursor is not None
        last_rowid, next_sequence, last_log_rowid = (
            int(cursor[0]),
            int(cursor[1]),
            int(cursor[2]),
        )
        rows = self._conn.execute(
            "SELECT rowid, key, step, ts, value, rank, node_id, attempt FROM metrics"
            " WHERE run_id = $1 AND rowid > $2 ORDER BY rowid LIMIT $3",
            [self._run_id, last_rowid, MAX_POINTS_PER_BATCH],
        ).fetchall()
        if not rows:
            return self._build_log_batch(next_sequence, last_log_rowid)
        group_key = (int(rows[0][5]), str(rows[0][6]), int(rows[0][7]))
        take = []
        for row in rows:
            if (int(row[5]), str(row[6]), int(row[7])) != group_key:
                break
            take.append(row)
        rank, node_id, attempt = group_key
        sequence_end = next_sequence + len(take) - 1
        batch_id, payload = self._encode_batch(
            rank=rank,
            node_id=node_id,
            attempt=attempt,
            sequence_start=next_sequence,
            sequence_end=sequence_end,
            metrics=[
                {
                    "name": str(row[1]),
                    "step": int(row[2]),
                    "ts": float(row[3]),
                    "value": float(row[4]),
                }
                for row in take
            ],
            logs=[],
        )
        return self._commit_outbox(
            batch_id,
            payload,
            sequence_start=next_sequence,
            sequence_end=sequence_end,
            cursor_update=(
                "UPDATE sync_cursor SET last_rowid = $1, next_sequence = $2"
                " WHERE run_id = $3",
                [int(take[-1][0]), sequence_end + 1, self._run_id],
            ),
        )

    def _build_log_batch(
        self, next_sequence: int, last_log_rowid: int
    ) -> Optional[Tuple[str, bytes]]:
        rows = self._conn.execute(
            "SELECT rowid, ts, level, source, message, rank, node_id, attempt"
            " FROM log_lines WHERE run_id = $1 AND rowid > $2 ORDER BY rowid LIMIT $3",
            [self._run_id, last_log_rowid, MAX_POINTS_PER_BATCH],
        ).fetchall()
        if not rows:
            return None
        group_key = (int(rows[0][5]), str(rows[0][6]), int(rows[0][7]))
        take = []
        for row in rows:
            if (int(row[5]), str(row[6]), int(row[7])) != group_key:
                break
            take.append(row)
        rank, node_id, attempt = group_key
        sequence_end = next_sequence + len(take) - 1
        batch_id, payload = self._encode_batch(
            rank=rank,
            node_id=node_id,
            attempt=attempt,
            sequence_start=next_sequence,
            sequence_end=sequence_end,
            metrics=[],
            logs=[
                {
                    "ts": float(row[1]),
                    "level": str(row[2]),
                    "source": str(row[3]),
                    "message": str(row[4]),
                }
                for row in take
            ],
        )
        return self._commit_outbox(
            batch_id,
            payload,
            sequence_start=next_sequence,
            sequence_end=sequence_end,
            cursor_update=(
                "UPDATE sync_cursor SET last_log_rowid = $1, next_sequence = $2"
                " WHERE run_id = $3",
                [int(take[-1][0]), sequence_end + 1, self._run_id],
            ),
        )

    def _encode_batch(
        self,
        *,
        rank: int,
        node_id: str,
        attempt: int,
        sequence_start: int,
        sequence_end: int,
        metrics: List[Dict[str, Any]],
        logs: List[Dict[str, Any]],
    ) -> Tuple[str, bytes]:
        batch_id = str(uuid.uuid4())
        payload = json.dumps(
            {
                "batch_id": batch_id,
                "writer_id": self._writer_id,
                "rank": rank,
                "node_id": node_id,
                "attempt": attempt,
                "sequence_start": sequence_start,
                "sequence_end": sequence_end,
                "metrics": metrics,
                "logs": logs,
            },
            ensure_ascii=False,
        ).encode()
        return batch_id, payload

    def _commit_outbox(
        self,
        batch_id: str,
        payload: bytes,
        *,
        sequence_start: int,
        sequence_end: int,
        cursor_update: Tuple[str, List[Any]],
    ) -> Tuple[str, bytes]:
        """Persist the batch and advance the cursor atomically BEFORE the first
        send: after a crash the payload is resent byte-identical, never rebuilt."""
        self._conn.execute("BEGIN")
        try:
            self._conn.execute(
                "INSERT INTO sync_outbox (batch_id, run_id, sequence_start, sequence_end,"
                " payload, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
                [
                    batch_id,
                    self._run_id,
                    sequence_start,
                    sequence_end,
                    payload,
                    time.time(),
                ],
            )
            sql, params = cursor_update
            self._conn.execute(sql, params)
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise
        return batch_id, payload

    def _send_batch(self, batch_id: str, payload: bytes) -> None:
        headers = {"content-type": "application/json"}
        body = payload
        if len(payload) > GZIP_THRESHOLD_BYTES:
            body = gzip.compress(payload)
            headers["content-encoding"] = "gzip"
        try:
            self._request(
                "POST",
                f"/api/v1/runs/{self._run_id}/batches",
                body=body,
                headers=headers,
            )
        except urllib.error.HTTPError as error:
            # 409 = digest mismatch on a replayed id: the server kept the original
            # bytes, so retrying forever would wedge the queue — drop and move on.
            if error.code != 409:
                raise
        self._conn.execute("DELETE FROM sync_outbox WHERE batch_id = $1", [batch_id])

    # ---- HTTP (stdlib only; the SDK stays dependency-light) ----

    def _post_json(self, path: str, payload: Dict[str, Any]) -> None:
        self._request(
            "POST",
            path,
            body=json.dumps(payload, ensure_ascii=False).encode(),
            headers={"content-type": "application/json"},
        )

    def _headers(self, headers: Dict[str, str]) -> Dict[str, str]:
        if self._config.api_key:
            return {**headers, "authorization": f"Bearer {self._config.api_key}"}
        return headers

    def _request(
        self, method: str, path: str, *, body: bytes, headers: Dict[str, str]
    ) -> None:
        request = urllib.request.Request(
            self._config.api_url + path,
            data=body,
            method=method,
            headers=self._headers(headers),
        )
        with urllib.request.urlopen(request, timeout=10):
            pass

    def _request_json(
        self, method: str, path: str, *, body: bytes, headers: Dict[str, str]
    ) -> Dict[str, Any]:
        request = urllib.request.Request(
            self._config.api_url + path,
            data=body,
            method=method,
            headers=self._headers(headers),
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + "Z"
