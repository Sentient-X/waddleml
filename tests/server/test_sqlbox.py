"""The SQL sandbox: full DuckDB expressiveness inside the org jail; hostile
SQL fails typed; foreign-org data is physically absent."""

from __future__ import annotations

from uuid import uuid4

import duckdb
import pytest
from fastapi.testclient import TestClient

from waddle_server.server.storage import parquet_key

from .conftest import ORG_A, FakeMetricStore, FakeObjectStore, requires_dev_postgres
from .test_ingest_contract import _create_run

pytestmark = requires_dev_postgres


def _metrics_parquet(rows: list[tuple[str, str, int, float, float]]) -> bytes:
    """Build a metrics-shaped parquet in memory (the compactor's schema)."""
    conn = duckdb.connect()
    conn.execute(
        "CREATE TABLE m (run_id VARCHAR, metric_name VARCHAR, step BIGINT,"
        " ts TIMESTAMP, value DOUBLE, rank INTEGER, node_id VARCHAR, attempt INTEGER)"
    )
    conn.executemany(
        "INSERT INTO m VALUES (?, ?, ?, to_timestamp(?), ?, 0, 'node0', 0)",
        [(r, m, s, ts, v) for r, m, s, v, ts in rows],
    )
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as scratch:
        dest = Path(scratch) / "m.parquet"
        conn.execute(f"COPY m TO '{dest}' (FORMAT parquet)")
        return dest.read_bytes()


def _sql(client: TestClient, query: str, key: str = "key-a-reader"):
    return client.post(
        "/api/v1/query/sql", headers={"x-api-key": key}, json={"sql": query}
    )


def test_full_duckdb_expressiveness_over_org_views(
    rig: tuple[TestClient, FakeMetricStore], blobs: FakeObjectStore
) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)
        blobs.objects[parquet_key(ORG_A.id, "metrics", "month=202607")] = _metrics_parquet(
            [(run_id, "loss", s, 1.0 / (s + 1), 1_753_000_000.0 + s) for s in range(50)]
        )

        # A join + window over the runs snapshot and the metrics parquet.
        result = _sql(
            client,
            """
            SELECT r.project, m.metric_name,
                   min(m.value) AS best,
                   arg_min(m.step, m.value) AS best_step,
                   count(*) AS points
            FROM metrics m JOIN runs r USING (run_id)
            GROUP BY ALL
            """,
        )
        assert result.status_code == 200, result.text
        payload = result.json()
        assert payload["columns"] == ["project", "metric_name", "best", "best_step", "points"]
        assert payload["rows"] == [["demo", "loss", 1.0 / 50, 49, 50]]

        # Row cap reports truncation honestly.
        capped = client.post(
            "/api/v1/query/sql",
            headers={"x-api-key": "key-a-reader"},
            json={"sql": "SELECT * FROM metrics", "max_rows": 10},
        ).json()
        assert len(capped["rows"]) == 10 and capped["truncated"] is True


def test_foreign_org_sees_nothing(
    rig: tuple[TestClient, FakeMetricStore], blobs: FakeObjectStore
) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)
        blobs.objects[parquet_key(ORG_A.id, "metrics", "month=202607")] = _metrics_parquet(
            [(run_id, "loss", 0, 1.0, 1_753_000_000.0)]
        )
        # Org B: its own empty jail — org A's runs and metrics do not exist.
        runs_b = _sql(client, "SELECT count(*) FROM runs", key="key-b-writer").json()
        assert runs_b["rows"] == [[0]]
        metrics_b = _sql(client, "SELECT * FROM metrics", key="key-b-writer")
        assert metrics_b.status_code == 422  # no export for org B → no view at all
        assert metrics_b.json()["detail"]["code"] == "sql_query_failed"


HOSTILE = [
    "SELECT * FROM read_parquet('/etc/passwd')",
    "SELECT * FROM read_csv_auto('/etc/hosts')",
    "ATTACH '/tmp/steal.db' AS steal",
    "INSTALL httpfs",
    "LOAD httpfs",
    "SET enable_external_access = true",
    "COPY runs TO '/tmp/exfil.parquet' (FORMAT parquet)",
    "SELECT * FROM read_parquet('https://example.com/x.parquet')",
    "EXPORT DATABASE '/tmp/exfil'",
]


@pytest.mark.parametrize("query", HOSTILE, ids=[q.split("(")[0].strip()[:28] for q in HOSTILE])
def test_hostile_sql_fails_typed(
    rig: tuple[TestClient, FakeMetricStore], query: str
) -> None:
    client, _ = rig
    with client:
        response = _sql(client, query)
        assert response.status_code == 422, response.text
        assert response.json()["detail"]["code"] in ("sql_query_failed", "sql_crashed")
