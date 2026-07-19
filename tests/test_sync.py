"""The sync engine's delivery contract: offline-first, at-least-once with
byte-identical replays, crash-recovery from the spool, bounded shutdown."""

from __future__ import annotations

import gzip
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

import waddle
from waddle import ResearchGoal, ResearchTrial
from waddle._db import WaddleDB
from waddle._sync import SyncConfig, SyncEngine


class FakeServer:
    """Stdlib HTTP fake: records every request; can fail batches on demand."""

    def __init__(self):
        self.requests = []  # (path, decompressed_body_bytes)
        self.auth_headers = []
        self.batch_digests = {}  # batch_id -> sha256 of body
        self.fail_batches = False
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length", 0)))
                if self.headers.get("content-encoding") == "gzip":
                    body = gzip.decompress(body)
                fake.requests.append((self.path, body))
                fake.auth_headers.append(self.headers.get("authorization"))
                if "/batches" in self.path:
                    if fake.fail_batches:
                        self.send_response(503)
                        self.end_headers()
                        return
                    payload = json.loads(body)
                    fake.batch_digests.setdefault(
                        payload["batch_id"], hashlib.sha256(body).hexdigest()
                    )
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()

    def delivered_points(self):
        """Logical points across all accepted batch requests, deduped by batch id."""
        seen, points = set(), []
        for path, body in self.requests:
            if "/batches" not in path:
                continue
            payload = json.loads(body)
            if payload["batch_id"] in seen:
                continue
            seen.add(payload["batch_id"])
            points.extend(payload["metrics"])
        return points


@pytest.fixture()
def server():
    fake = FakeServer()
    yield fake
    fake.close()


def _engine(db, server, run_id):
    return SyncEngine(
        db,
        SyncConfig(api_url=server.url, api_key="k"),
        run_id=run_id,
        project="proj",
        name="run",
        config_dict={"lr": 0.1},
        commit_sha=None,
        started_at=1_753_000_000.0,
        resume=False,
        rank=0,
        local_rank=0,
        world_size=1,
        node_id="node0",
        attempt=0,
        start_thread=False,
    )


def _spool_metrics(db, run_id, count, start=0, attempt=0):
    for i in range(start, start + count):
        db.execute(
            "INSERT INTO metrics (run_id, key, step, ts, value, rank, node_id, attempt)"
            " VALUES ($1, 'loss', $2, $3, $4, 0, 'node0', $5)",
            [run_id, i, 1_753_000_000.0 + i, 1.0 / (i + 1), attempt],
        )


def test_happy_path_delivers_all_points(tmp_path, server):
    db = WaddleDB(str(tmp_path / "w.duckdb"))
    run_id = "a" * 32
    _spool_metrics(db, run_id, 7)
    engine = _engine(db, server, run_id)
    engine.drain_once()

    assert server.requests[0][0] == "/api/v1/runs"
    created = json.loads(server.requests[0][1])
    assert created["run_id"] == run_id and created["config"] == {"lr": 0.1}
    points = server.delivered_points()
    assert [p["step"] for p in points] == list(range(7))
    # Outbox is empty after acks; a second drain sends nothing new.
    before = len(server.requests)
    engine.drain_once()
    assert len(server.requests) == before
    db.close()


def test_crash_recovery_replays_byte_identical(tmp_path, server):
    db = WaddleDB(str(tmp_path / "w.duckdb"))
    run_id = "b" * 32
    _spool_metrics(db, run_id, 5)

    # First engine: the server rejects batches, so the batch stays in the outbox
    # (the crash window: payload persisted, never acked).
    engine1 = _engine(db, server, run_id)
    server.fail_batches = True
    with pytest.raises(Exception):
        engine1.drain_once()
    outbox = db.fetchall("SELECT batch_id, payload FROM sync_outbox")
    assert len(outbox) == 1
    persisted_digest = hashlib.sha256(bytes(outbox[0][1])).hexdigest()

    # "Restart": a new engine over the same spool resends the persisted bytes.
    server.fail_batches = False
    engine2 = _engine(db, server, run_id)
    engine2.drain_once()
    assert db.fetchall("SELECT 1 FROM sync_outbox") == []
    assert server.batch_digests[str(outbox[0][0])] == persisted_digest
    assert [p["step"] for p in server.delivered_points()] == list(range(5))
    # writer_id survived the restart (sequence numbering stays monotone).
    assert engine2._writer_id == engine1._writer_id
    db.close()


def test_attempt_boundary_splits_batches(tmp_path, server):
    db = WaddleDB(str(tmp_path / "w.duckdb"))
    run_id = "c" * 32
    _spool_metrics(db, run_id, 3, start=0, attempt=0)
    _spool_metrics(db, run_id, 2, start=2, attempt=1)  # resume rewrote step 2+
    _engine(db, server, run_id).drain_once()

    batches = [json.loads(b) for p, b in server.requests if "/batches" in p]
    assert [b["attempt"] for b in batches] == [0, 1]
    assert (batches[0]["sequence_start"], batches[0]["sequence_end"]) == (0, 2)
    assert (batches[1]["sequence_start"], batches[1]["sequence_end"]) == (3, 4)
    db.close()


def test_log_lines_drain_after_metrics_on_one_sequence(tmp_path, server):
    db = WaddleDB(str(tmp_path / "w.duckdb"))
    run_id = "d" * 32
    _spool_metrics(db, run_id, 3)
    for i in range(2):
        db.execute(
            "INSERT INTO log_lines (run_id, ts, level, source, message, rank, node_id, attempt)"
            " VALUES ($1, $2, 'info', 'train', $3, 0, 'node0', 0)",
            [run_id, 1_753_000_000.0 + i, f"line {i}"],
        )
    _engine(db, server, run_id).drain_once()

    batches = [json.loads(b) for p, b in server.requests if "/batches" in p]
    assert [len(b["metrics"]) for b in batches] == [3, 0]
    assert [len(b["logs"]) for b in batches] == [0, 2]
    # Logs continue the metrics' sequence — one monotone counter per writer.
    assert (batches[1]["sequence_start"], batches[1]["sequence_end"]) == (3, 4)
    assert batches[1]["logs"][0] == {
        "ts": 1_753_000_000.0,
        "level": "info",
        "source": "train",
        "message": "line 0",
    }
    db.close()


def test_captured_logging_reaches_the_server(tmp_path, server, monkeypatch):
    import logging

    monkeypatch.setenv("WADDLE_API_URL", server.url)
    monkeypatch.setenv("WADDLE_API_KEY", "k")
    run = waddle.init(
        project="p", db_path=str(tmp_path / "w.duckdb"), system_metrics=False
    )
    logger = logging.getLogger("test.capture")
    logger.setLevel(logging.INFO)
    logger.warning("dataloader stalled")
    waddle.log_line("explicit line", level="error", source="eval")
    run.finish()

    lines = []
    for path, body in server.requests:
        if "/batches" in path:
            lines.extend(json.loads(body)["logs"])
    assert {(line["level"], line["message"]) for line in lines} == {
        ("warning", "dataloader stalled"),
        ("error", "explicit line"),
    }
    # The handler is detached on finish — later records don't touch the run.
    from waddle._run import _LogCaptureHandler

    assert run._log_handler is None
    assert not any(
        isinstance(h, _LogCaptureHandler) for h in logging.getLogger().handlers
    )


def test_environment_registers_with_the_run(tmp_path, server, monkeypatch):
    monkeypatch.setenv("WADDLE_API_URL", server.url)
    monkeypatch.setenv("WADDLE_API_KEY", "k")
    run = waddle.init(
        project="p", db_path=str(tmp_path / "w.duckdb"), system_metrics=False
    )
    run.finish()
    created = json.loads(server.requests[0][1])
    env = created["environment"]
    assert env["hostname"] and env["python_version"] and env["command"]
    assert isinstance(env["cpu_count"], int)


def test_no_env_means_no_engine(tmp_path, monkeypatch):
    monkeypatch.delenv("WADDLE_API_URL", raising=False)
    monkeypatch.delenv("WADDLE_API_KEY", raising=False)
    run = waddle.init(
        project="p", db_path=str(tmp_path / "w.duckdb"), system_metrics=False
    )
    assert run._sync is None
    run.finish()


def test_env_wires_engine_and_finish_reports_state(tmp_path, server, monkeypatch):
    monkeypatch.setenv("WADDLE_API_URL", server.url)
    monkeypatch.setenv("WADDLE_API_KEY", "k")
    run = waddle.init(
        project="p", db_path=str(tmp_path / "w.duckdb"), system_metrics=False
    )
    assert run._sync is not None
    run.log({"loss": 0.5})
    run.log({"loss": 0.25})
    run.finish()

    paths = [p for p, _ in server.requests]
    assert paths[0] == "/api/v1/runs"
    assert any("/batches" in p for p in paths)
    finish = json.loads(server.requests[-1][1])
    assert server.requests[-1][0].endswith("/finish") and finish["state"] == "completed"
    assert [p["value"] for p in server.delivered_points()] == [0.5, 0.25]


def test_research_contract_is_registered_with_hosted_run(tmp_path, server, monkeypatch):
    monkeypatch.setenv("WADDLE_API_URL", server.url)
    monkeypatch.setenv("WADDLE_API_KEY", "k")
    run = waddle.init(
        project="edge-inference",
        db_path=str(tmp_path / "w.duckdb"),
        research=ResearchTrial(
            campaign="m10-5090",
            trial_index=0,
            objective_name="latency/p99_ms",
            goal=ResearchGoal.MINIMIZE,
            hypothesis="native baseline",
        ),
        system_metrics=False,
    )
    run.log({"latency/p99_ms": 25.0})
    run.finish()

    created = json.loads(server.requests[0][1])
    assert created["group_name"] == "m10-5090"
    assert created["job_type"] == "autoresearch"
    assert created["research"] == {
        "trial_index": 0,
        "objective_name": "latency/p99_ms",
        "goal": "minimize",
        "hypothesis": "native baseline",
        "parent_run_id": None,
    }


def test_url_alone_activates_keyless_sync(tmp_path, server, monkeypatch):
    # Dev convenience: against an auth-optional dev server no key is needed —
    # the engine sends NO authorization header (empty is never introspected).
    monkeypatch.setenv("WADDLE_API_URL", server.url)
    monkeypatch.delenv("WADDLE_API_KEY", raising=False)
    run = waddle.init(
        project="p", db_path=str(tmp_path / "w.duckdb"), system_metrics=False
    )
    assert run._sync is not None
    run.log({"loss": 1.0})
    run.finish()
    assert [p["value"] for p in server.delivered_points()] == [1.0]
    assert set(server.auth_headers) == {None}
