"""Ingest metering trips typed 429s; migrations are idempotent."""

from __future__ import annotations

from uuid import uuid4

from fastapi.testclient import TestClient

from waddle_server.config import WaddleSettings
from waddle_server.server import db, quotas
from waddle_server.server.app import build_app

from .conftest import FakeMetricStore, StubAuthClient, requires_dev_postgres
from .test_ingest_contract import _batch_body, _create_run

pytestmark = requires_dev_postgres


def test_rpm_quota_trips(fresh_db: str) -> None:
    quotas.reset()
    app = build_app(
        settings=WaddleSettings(pg_dsn=fresh_db, auth_required=True, ingest_rpm=2),
        auth_client=StubAuthClient(),
        metric_store=FakeMetricStore(),
    )
    with TestClient(app) as client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)
        for expected in (200, 200, 429):
            response = client.post(
                f"/api/v1/runs/{run_id}/batches",
                headers={"x-api-key": "key-a-writer"},
                content=_batch_body(
                    batch_id=str(uuid4()), writer_id=str(uuid4()), seq=0, points=1
                ),
            )
            assert response.status_code == expected
        assert response.json()["detail"]["code"] == "quota_exceeded"


def test_migrations_idempotent(fresh_db: str) -> None:
    first = db.migrate(fresh_db)
    assert "0001_init.sql" in first
    assert db.migrate(fresh_db) == []
