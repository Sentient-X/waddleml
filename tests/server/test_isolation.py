"""Company isolation is fail-closed: cross-org existence is a 404, lists never
leak, and query paths return nothing for a foreign org."""

from __future__ import annotations

from uuid import uuid4

from fastapi.testclient import TestClient

from .conftest import FakeMetricStore, requires_dev_postgres
from .test_ingest_contract import _batch_body, _create_run

pytestmark = requires_dev_postgres


def test_cross_org_isolation(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)
        body = _batch_body(batch_id=str(uuid4()), writer_id=str(uuid4()), seq=0, points=3)
        client.post(
            f"/api/v1/runs/{run_id}/batches", headers={"x-api-key": "key-a-writer"}, content=body
        )

        # Org B sees nothing of org A: not the run, not the list, not the metrics.
        assert (
            client.get(f"/api/v1/runs/{run_id}", headers={"x-api-key": "key-b-writer"}).status_code
            == 404
        )
        assert client.get("/api/v1/runs", headers={"x-api-key": "key-b-writer"}).json() == []
        assert (
            client.post(
                f"/api/v1/runs/{run_id}/batches",
                headers={"x-api-key": "key-b-writer"},
                content=_batch_body(batch_id=str(uuid4()), writer_id=str(uuid4()), seq=0, points=1),
            ).status_code
            == 404
        )
        assert (
            client.post(
                "/api/v1/query/metrics",
                headers={"x-api-key": "key-b-writer"},
                json={"run_ids": [run_id]},
            ).json()
            == []
        )
        assert (
            client.get(
                f"/api/v1/runs/{run_id}/logs", headers={"x-api-key": "key-b-writer"}
            ).status_code
            == 404
        )

        # Same-project names do not collide across orgs.
        b_run = uuid4().hex
        assert _create_run(client, "key-b-writer", b_run).status_code == 200
        a_runs = client.get("/api/v1/runs", headers={"x-api-key": "key-a-reader"}).json()
        assert [r["run_id"] for r in a_runs] == [run_id]


def test_query_limits(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        too_many = [uuid4().hex for _ in range(51)]
        refused = client.post(
            "/api/v1/query/metrics",
            headers={"x-api-key": "key-a-reader"},
            json={"run_ids": too_many},
        )
        assert refused.status_code == 422
        assert refused.json()["detail"]["code"] == "query_limit_exceeded"
