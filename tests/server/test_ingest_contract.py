"""The ingest contract: create-or-attach runs, idempotent batches, role gates."""

from __future__ import annotations

import gzip
import json
import time
from uuid import uuid4

from fastapi.testclient import TestClient

from .conftest import FakeMetricStore, requires_dev_postgres

pytestmark = requires_dev_postgres


def _create_run(
    client: TestClient, key: str, run_id: str, *, rank: int = 0, resume: bool = False
):
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


def _create_research_run(
    client: TestClient,
    run_id: str,
    *,
    trial_index: int,
    parent_run_id: str | None = None,
    objective_name: str = "latency/p99_ms",
    session_name: str | None = "overnight-sm120",
    campaign: str = "m10-5090",
    subject_run_id: str | None = None,
):
    return client.post(
        "/api/v1/runs",
        headers={"x-api-key": "key-a-writer"},
        json={
            "run_id": run_id,
            "project": "edge-inference",
            "name": f"trial-{trial_index}",
            "group_name": campaign,
            "job_type": "autoresearch",
            "research": {
                "trial_index": trial_index,
                "objective_name": objective_name,
                "goal": "minimize",
                "hypothesis": "baseline"
                if trial_index == 0
                else "remove launch overhead",
                "session_name": session_name,
                "parent_run_id": parent_run_id,
                "subject_run_id": subject_run_id,
            },
            "config": {"batch_size": 1},
            "started_at": "2026-07-19T00:00:00Z",
            "worker": {
                "rank": 0,
                "local_rank": 0,
                "world_size": 1,
                "node_id": "rtx5090",
                "attempt": 0,
                "writer_id": str(uuid4()),
            },
        },
    )


def _batch_body(
    *, batch_id: str, writer_id: str, seq: int, points: int, step0: int = 0
) -> bytes:
    now = time.time()
    return json.dumps(
        {
            "batch_id": batch_id,
            "writer_id": writer_id,
            "sequence_start": seq,
            "sequence_end": seq + points - 1,
            "metrics": [
                {
                    "name": "loss",
                    "step": step0 + i,
                    "ts": now + i,
                    "value": 1.0 / (i + 1),
                }
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


def test_environment_roundtrip(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        resp = client.post(
            "/api/v1/runs",
            headers={"x-api-key": "key-a-writer"},
            json={
                "run_id": run_id,
                "project": "demo",
                "name": "env-run",
                "config": {},
                "environment": {
                    "hostname": "trainbox",
                    "python_version": "3.12.4",
                    "command": "python train.py +exp=libero",
                    "cpu_count": 32,
                    "gpu": "NVIDIA RTX 4090",
                    "git_remote": "git@github.com:Sentient-X/train.git",
                    "git_commit": "a" * 40,
                    "git_dirty": True,
                },
                "started_at": "2026-07-19T00:00:00Z",
                "resume": False,
                "worker": {
                    "rank": 0,
                    "local_rank": 0,
                    "world_size": 1,
                    "node_id": "node0",
                    "attempt": 0,
                    "writer_id": str(uuid4()),
                },
            },
        )
        assert resp.status_code == 200
        detail = client.get(
            f"/api/v1/runs/{run_id}", headers={"x-api-key": "key-a-reader"}
        ).json()
        env = detail["environment"]
        assert env["hostname"] == "trainbox" and env["git_dirty"] is True
        assert env["os"] is None  # absent facts stay absent, never defaulted

        # A rank>0 attach without environment must not clobber rank 0's capture.
        assert _create_run(client, "key-a-writer", run_id, rank=1).status_code == 200
        again = client.get(
            f"/api/v1/runs/{run_id}", headers={"x-api-key": "key-a-reader"}
        ).json()
        assert again["environment"]["hostname"] == "trainbox"

        # Runs created without one report null, not an empty shell.
        bare_id = uuid4().hex
        _create_run(client, "key-a-writer", bare_id)
        bare = client.get(
            f"/api/v1/runs/{bare_id}", headers={"x-api-key": "key-a-reader"}
        ).json()
        assert bare["environment"] is None


def test_batch_idempotency_and_digest_mismatch(
    rig: tuple[TestClient, FakeMetricStore],
) -> None:
    client, store = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)
        batch_id, writer_id = str(uuid4()), str(uuid4())
        body = _batch_body(batch_id=batch_id, writer_id=writer_id, seq=0, points=5)

        first = client.post(
            f"/api/v1/runs/{run_id}/batches",
            headers={"x-api-key": "key-a-writer"},
            content=body,
        )
        assert first.status_code == 200 and first.json()["replayed"] is False
        assert len(store.metrics) == 5

        replay = client.post(
            f"/api/v1/runs/{run_id}/batches",
            headers={"x-api-key": "key-a-writer"},
            content=body,
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
        run = client.get(
            f"/api/v1/runs/{run_id}", headers={"x-api-key": "key-a-reader"}
        ).json()
        assert run["summary"]["loss"] == 1.0 / 5


def test_research_trials_roundtrip_and_filter(
    rig: tuple[TestClient, FakeMetricStore],
) -> None:
    client, _ = rig
    with client:
        root_id = uuid4().hex
        child_id = uuid4().hex
        assert _create_research_run(client, root_id, trial_index=0).status_code == 200
        assert (
            _create_research_run(
                client, child_id, trial_index=1, parent_run_id=root_id
            ).status_code
            == 200
        )

        runs = client.get(
            "/api/v1/runs?job_type=autoresearch&group_name=m10-5090",
            headers={"x-api-key": "key-a-reader"},
        ).json()
        assert {run["run_id"] for run in runs} == {root_id, child_id}
        child = next(run for run in runs if run["run_id"] == child_id)
        assert child["config"] == {"batch_size": 1}
        assert child["research"] == {
            "trial_index": 1,
            "objective_name": "latency/p99_ms",
            "goal": "minimize",
            "hypothesis": "remove launch overhead",
            "session_name": "overnight-sm120",
            "parent_run_id": root_id,
            "subject_run_id": None,
            "rationale": None,
            "expected_outcome": None,
            "falsification_criteria": None,
        }


def test_research_sessions_are_compact_and_outcomes_are_immutable(
    rig: tuple[TestClient, FakeMetricStore],
) -> None:
    client, _ = rig
    with client:
        root_id = uuid4().hex
        assert _create_research_run(client, root_id, trial_index=0).status_code == 200
        outcome = {
            "decision": "baseline",
            "evidence": "native p99 is 25 ms and all gates passed",
            "conclusion": "this is the comparison reference",
            "failed_gates": [],
            "next_step": "test static buffers",
        }
        done = client.post(
            f"/api/v1/runs/{root_id}/finish",
            headers={"x-api-key": "key-a-writer"},
            json={
                "state": "completed",
                "summary": {"latency/p99_ms": 25.0},
                "research_outcome": outcome,
            },
        )
        assert done.status_code == 200
        assert done.json()["research_outcome"] == outcome

        sessions = client.get(
            "/api/v1/research/sessions",
            headers={"x-api-key": "key-a-reader"},
        ).json()
        assert sessions == [
            {
                "project": "edge-inference",
                "session_name": "overnight-sm120",
                "phase_count": 1,
                "trial_count": 1,
                "running_count": 0,
                "started_at": "2026-07-19T00:00:00Z",
                "updated_at": done.json()["finished_at"],
            }
        ]
        trials = client.get(
            "/api/v1/research/sessions/edge-inference/overnight-sm120",
            headers={"x-api-key": "key-a-reader"},
        ).json()
        assert len(trials) == 1
        assert set(trials[0]) == {
            "run_id",
            "project",
            "name",
            "state",
            "campaign",
            "research",
            "research_outcome",
            "objective_value",
            "commit_sha",
            "started_at",
            "finished_at",
            "heartbeat_at",
        }
        assert trials[0]["objective_value"] == 25.0
        assert "config" not in trials[0] and "summary" not in trials[0]

        conflict = client.post(
            f"/api/v1/runs/{root_id}/finish",
            headers={"x-api-key": "key-a-writer"},
            json={
                "state": "completed",
                "research_outcome": {**outcome, "decision": "discard"},
            },
        )
        assert conflict.status_code == 422
        assert conflict.json()["detail"]["code"] == "invalid_research_trial"


def test_research_contract_supports_cross_phase_lineage_and_rejects_foreign_links(
    rig: tuple[TestClient, FakeMetricStore],
) -> None:
    client, _ = rig
    with client:
        root_id = uuid4().hex
        assert _create_research_run(client, root_id, trial_index=0).status_code == 200

        untyped_attach = _create_run(client, "key-a-writer", root_id, rank=1)
        assert untyped_attach.status_code == 422
        assert untyped_attach.json()["detail"]["code"] == "invalid_research_trial"

        mixed = _create_research_run(
            client,
            uuid4().hex,
            trial_index=1,
            parent_run_id=root_id,
            objective_name="throughput",
        )
        assert mixed.status_code == 200

        legacy_root = _create_research_run(
            client,
            uuid4().hex,
            trial_index=0,
            session_name=None,
            campaign="legacy-campaign",
        )
        assert legacy_root.status_code == 200
        explicit_project_session = _create_research_run(
            client,
            uuid4().hex,
            trial_index=1,
            session_name="edge-inference",
            campaign="legacy-campaign",
        )
        assert explicit_project_session.status_code == 200

        cross_phase_child = _create_research_run(
            client,
            uuid4().hex,
            trial_index=0,
            parent_run_id=root_id,
            campaign="m10-quality",
            objective_name="quality/success_rate",
        )
        assert cross_phase_child.status_code == 200

        mixed_session = _create_research_run(
            client,
            uuid4().hex,
            trial_index=1,
            parent_run_id=root_id,
            session_name="another-overnight-run",
        )
        assert mixed_session.status_code == 422
        assert mixed_session.json()["detail"]["code"] == "invalid_research_trial"

        blank_session = _create_research_run(
            client,
            uuid4().hex,
            trial_index=1,
            session_name="   ",
            campaign="blank-session",
        )
        assert blank_session.status_code == 422

        evaluation = _create_research_run(
            client,
            uuid4().hex,
            trial_index=0,
            campaign="m10-quality",
            objective_name="quality/success_rate",
            subject_run_id=root_id,
        )
        assert evaluation.status_code == 200

        foreign_parent = _create_research_run(
            client, uuid4().hex, trial_index=2, parent_run_id=uuid4().hex
        )
        assert foreign_parent.status_code == 422
        assert foreign_parent.json()["detail"]["code"] == "invalid_research_trial"

        foreign_subject = _create_research_run(
            client,
            uuid4().hex,
            trial_index=1,
            campaign="m10-quality",
            objective_name="quality/success_rate",
            subject_run_id=uuid4().hex,
        )
        assert foreign_subject.status_code == 422
        assert foreign_subject.json()["detail"]["code"] == "invalid_research_trial"


def test_gzip_body_and_sequence_gap_warning(
    rig: tuple[TestClient, FakeMetricStore],
) -> None:
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

        gapped = _batch_body(
            batch_id=str(uuid4()), writer_id=writer_id, seq=10, points=3, step0=3
        )
        warned = client.post(
            f"/api/v1/runs/{run_id}/batches",
            headers={"x-api-key": "key-a-writer"},
            content=gapped,
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
            client.get(
                "/api/v1/runs", headers={"x-api-key": "key-a-reader"}
            ).status_code
            == 200
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
        body = _batch_body(
            batch_id=str(uuid4()), writer_id=str(uuid4()), seq=0, points=50
        )
        client.post(
            f"/api/v1/runs/{run_id}/batches",
            headers={"x-api-key": "key-a-writer"},
            content=body,
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
