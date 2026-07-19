"""The ingest contract: create-or-attach runs, idempotent batches, role gates."""

from __future__ import annotations

import gzip
import json
import time
from uuid import uuid4

from fastapi.testclient import TestClient

from .conftest import FakeMetricStore, requires_dev_postgres

pytestmark = requires_dev_postgres


def _create_run(client: TestClient, key: str, run_id: str, *, rank: int = 0, resume: bool = False):
    return client.post(
        "/api/v1/runs",
        headers={"x-api-key": key},
        json={
            "run_id": run_id,
            "project": "demo",
            "name": f"run-{run_id[:6]}",
            "config": {"lr": 0.01},
            "started_at": "2026-07-19T00:00:00Z",
            "resume": resume,
            "worker": {
                "rank": rank,
                "local_rank": rank,
                "world_size": 2,
                "node_id": f"node{rank}",
                "attempt": 0,
                "writer_id": str(uuid4()),
            },
        },
    )


def _batch_body(*, batch_id: str, writer_id: str, seq: int, points: int, step0: int = 0) -> bytes:
    now = time.time()
    return json.dumps(
        {
            "batch_id": batch_id,
            "writer_id": writer_id,
            "sequence_start": seq,
            "sequence_end": seq + points - 1,
            "metrics": [
                {"name": "loss", "step": step0 + i, "ts": now + i, "value": 1.0 / (i + 1)}
                for i in range(points)
            ],
            "logs": [],
        }
    ).encode()


def test_create_or_attach_and_detail(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        assert _create_run(client, "key-a-writer", run_id).status_code == 200
        ref = _create_run(client, "key-a-writer", run_id, rank=1).json()
        assert ref["run_id"] == run_id and ref["org_slug"] == "org-a"

        detail = client.get(
            f"/api/v1/runs/{run_id}", headers={"x-api-key": "key-a-reader"}
        ).json()
        assert detail["state"] == "running"
        assert {w["rank"] for w in detail["workers"]} == {0, 1}
        assert detail["config"] == {"lr": 0.01}


def test_batch_idempotency_and_digest_mismatch(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, store = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)
        batch_id, writer_id = str(uuid4()), str(uuid4())
        body = _batch_body(batch_id=batch_id, writer_id=writer_id, seq=0, points=5)

        first = client.post(
            f"/api/v1/runs/{run_id}/batches", headers={"x-api-key": "key-a-writer"}, content=body
        )
        assert first.status_code == 200 and first.json()["replayed"] is False
        assert len(store.metrics) == 5

        replay = client.post(
            f"/api/v1/runs/{run_id}/batches", headers={"x-api-key": "key-a-writer"}, content=body
        )
        assert replay.status_code == 200 and replay.json()["replayed"] is True

        mutated = _batch_body(batch_id=batch_id, writer_id=writer_id, seq=0, points=6)
        conflict = client.post(
            f"/api/v1/runs/{run_id}/batches",
            headers={"x-api-key": "key-a-writer"},
            content=mutated,
        )
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["code"] == "batch_digest_mismatch"

        # Latest-scalar summary landed on the run row (renders without ClickHouse).
        run = client.get(f"/api/v1/runs/{run_id}", headers={"x-api-key": "key-a-reader"}).json()
        assert run["summary"]["loss"] == 1.0 / 5


def test_gzip_body_and_sequence_gap_warning(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)
        writer_id = str(uuid4())
        first = _batch_body(batch_id=str(uuid4()), writer_id=writer_id, seq=0, points=3)
        ok = client.post(
            f"/api/v1/runs/{run_id}/batches",
            headers={"x-api-key": "key-a-writer", "content-encoding": "gzip"},
            content=gzip.compress(first),
        )
        assert ok.status_code == 200 and ok.json()["warnings"] == []

        gapped = _batch_body(batch_id=str(uuid4()), writer_id=writer_id, seq=10, points=3, step0=3)
        warned = client.post(
            f"/api/v1/runs/{run_id}/batches", headers={"x-api-key": "key-a-writer"}, content=gapped
        )
        assert warned.status_code == 200
        assert any("sequence gap" in w for w in warned.json()["warnings"])


def test_finish_and_role_gates(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)

        # A reader can query but not write; an unknown key is 401.
        assert _create_run(client, "key-a-reader", uuid4().hex).status_code == 403
        assert (
            client.get("/api/v1/runs", headers={"x-api-key": "key-a-reader"}).status_code == 200
        )
        assert _create_run(client, "no-such-key", uuid4().hex).status_code == 401

        done = client.post(
            f"/api/v1/runs/{run_id}/finish",
            headers={"x-api-key": "key-a-writer"},
            json={"state": "completed", "summary": {"final_acc": 0.93}},
        )
        assert done.status_code == 200
        assert done.json()["state"] == "completed"
        assert done.json()["summary"]["final_acc"] == 0.93


def test_query_series_and_logs(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)
        body = _batch_body(batch_id=str(uuid4()), writer_id=str(uuid4()), seq=0, points=50)
        client.post(
            f"/api/v1/runs/{run_id}/batches", headers={"x-api-key": "key-a-writer"}, content=body
        )

        series = client.post(
            "/api/v1/query/metrics",
            headers={"x-api-key": "key-a-reader"},
            json={"run_ids": [run_id], "metric_names": ["loss"], "max_points": 10},
        ).json()
        assert len(series) == 1 and series[0]["metric_name"] == "loss"
        assert 0 < len(series[0]["points"]) <= 10

        latest = client.post(
            "/api/v1/query/latest",
            headers={"x-api-key": "key-a-reader"},
            json={"run_ids": [run_id]},
        ).json()
        assert latest[0]["step"] == 49
