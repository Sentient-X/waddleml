"""Reports + datasets doors: compile-validated saves, id-addressed resources
with an append-only version history, jailed renders, the producer substrate,
and company isolation on every one of them."""

from __future__ import annotations

from uuid import uuid4

from fastapi.testclient import TestClient

from .conftest import FakeMetricStore, FakeObjectStore, requires_dev_postgres
from .test_ingest_contract import _create_run

pytestmark = requires_dev_postgres

REPORT = """---
title: Run states
---

We have {states[0].n} runs in total.

```sql states
select count(*) as n, min(state) as first_state from runs
```

<BigValue data={states} value=n title="Runs" />
"""


def _create(client: TestClient, name: str, body: str, key: str = "key-a-writer"):
    return client.post(
        "/api/v1/reports", headers={"x-api-key": key}, json={"name": name, "body": body}
    )


def test_report_lifecycle_and_render(
    rig: tuple[TestClient, FakeMetricStore], blobs: FakeObjectStore
) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)

        created = _create(client, "run-states", REPORT)
        assert created.status_code == 201, created.text
        report = created.json()
        assert report["title"] == "Run states"
        assert report["queries"] == ["states"]
        assert report["version"] == 1
        report_id = report["id"]

        listed = client.get("/api/v1/reports", headers={"x-api-key": "key-a-reader"}).json()
        assert [(r["id"], r["name"]) for r in listed] == [(report_id, "run-states")]
        # Slug → id resolution for agents.
        by_name = client.get(
            "/api/v1/reports",
            headers={"x-api-key": "key-a-reader"},
            params={"name": "run-states"},
        ).json()
        assert [r["id"] for r in by_name] == [report_id]

        rendered = client.post(
            f"/api/v1/reports/{report_id}/render",
            headers={"x-api-key": "key-a-reader"},
            json={},
        )
        assert rendered.status_code == 200, rendered.text
        page = rendered.json()
        assert page["query_errors"] == {}
        states = page["results"]["states"]
        assert states["rows"] == [[1, "running"]]
        assert states["column_types"] == ["number", "string"]
        # Markdown interpolation resolved server-side.
        assert page["blocks"][0]["kind"] == "markdown"
        assert "We have 1 runs in total." in page["blocks"][0]["text"]
        assert page["blocks"][1]["component"] == "BigValue"
        assert page["blocks"][1]["query"] == "states"


def test_saves_append_versions_and_rename_rides_a_save(
    rig: tuple[TestClient, FakeMetricStore],
) -> None:
    client, _ = rig
    with client:
        report_id = _create(client, "history", "```sql q\nselect 1 as one\n```\n").json()["id"]

        v2 = client.put(
            f"/api/v1/reports/{report_id}",
            headers={"x-api-key": "key-a-writer"},
            json={"body": "```sql q\nselect 2 as two\n```\n", "name": "history-renamed"},
        )
        assert v2.status_code == 200, v2.text
        assert v2.json()["version"] == 2
        assert v2.json()["name"] == "history-renamed"
        assert v2.json()["id"] == report_id  # identity survives the rename

        versions = client.get(
            f"/api/v1/reports/{report_id}/versions", headers={"x-api-key": "key-a-reader"}
        ).json()
        assert [(v["version"], v["name"]) for v in versions] == [
            (2, "history-renamed"),
            (1, "history"),
        ]
        v1 = client.get(
            f"/api/v1/reports/{report_id}/versions/1", headers={"x-api-key": "key-a-reader"}
        ).json()
        assert "select 1 as one" in v1["body"]


def test_name_conflicts_are_409(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        _create(client, "taken", "```sql q\nselect 1\n```\n")
        other = _create(client, "other", "```sql q\nselect 1\n```\n").json()

        duplicate = _create(client, "taken", "```sql q\nselect 2\n```\n")
        assert duplicate.status_code == 409
        assert duplicate.json()["detail"]["code"] == "report_name_taken"

        collide = client.put(
            f"/api/v1/reports/{other['id']}",
            headers={"x-api-key": "key-a-writer"},
            json={"body": "```sql q\nselect 1\n```\n", "name": "taken"},
        )
        assert collide.status_code == 409
        assert collide.json()["detail"]["code"] == "report_name_taken"


def test_save_rejects_uncompilable_bodies(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        bad = _create(client, "broken", "```sql a\nselect * from (${a})\n```\n")
        assert bad.status_code == 422
        assert bad.json()["detail"]["code"] == "report_cycle"
        # Nothing was stored.
        assert client.get(
            "/api/v1/reports", headers={"x-api-key": "key-a-reader"}
        ).json() == []


def test_render_requires_declared_params(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        report_id = _create(
            client, "per-run", "```sql q\nselect * from runs where id = '${params.run_id}'\n```\n"
        ).json()["id"]
        response = client.post(
            f"/api/v1/reports/{report_id}/render",
            headers={"x-api-key": "key-a-reader"},
            json={"params": {}},
        )
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "missing_params"


def test_reports_are_org_isolated(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        report_id = _create(client, "mine", "```sql q\nselect 1 as one\n```\n").json()["id"]
        # Org B: existence is hidden (404 by id), list and lookup are empty.
        assert client.get(
            f"/api/v1/reports/{report_id}", headers={"x-api-key": "key-b-writer"}
        ).status_code == 404
        assert client.get(
            "/api/v1/reports", headers={"x-api-key": "key-b-writer"}
        ).json() == []


def test_reader_cannot_save(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        response = _create(client, "nope", "```sql q\nselect 1\n```\n", key="key-a-reader")
        assert response.status_code == 403


def test_preview_renders_without_saving(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        response = client.post(
            "/api/v1/reports/preview",
            headers={"x-api-key": "key-a-reader"},
            json={"body": "```sql q\nselect 41 + 1 as answer\n```\n<Value data={q} column=answer />"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["results"]["q"]["rows"] == [[42]]
        assert client.get("/api/v1/reports", headers={"x-api-key": "key-a-reader"}).json() == []


def test_dataset_door_feeds_sql_and_reports(
    rig: tuple[TestClient, FakeMetricStore], blobs: FakeObjectStore
) -> None:
    client, _ = rig
    with client:
        put = client.put(
            "/api/v1/datasets/factory_orders",
            headers={"x-api-key": "key-a-writer"},
            json={
                "columns": [
                    {"name": "order_id", "type": "string"},
                    {"name": "episodes", "type": "number"},
                ],
                "rows": [["ord-1", 120], ["ord-2", 80]],
            },
        )
        assert put.status_code == 200, put.text
        assert put.json() == {"dataset": "factory_orders", "rows": 2}

        listed = client.get("/api/v1/datasets", headers={"x-api-key": "key-a-reader"}).json()
        assert {d["dataset"] for d in listed} == {"factory_orders"}

        # The upload is a first-class view in the SQL sandbox…
        sql = client.post(
            "/api/v1/query/sql",
            headers={"x-api-key": "key-a-reader"},
            json={"sql": "select sum(episodes) from factory_orders"},
        )
        assert sql.status_code == 200, sql.text
        assert sql.json()["rows"] == [[200.0]]

        # …and in a report — the cross-pillar join, live.
        preview = client.post(
            "/api/v1/reports/preview",
            headers={"x-api-key": "key-a-reader"},
            json={
                "body": "```sql caps\nselect count(*) as orders, sum(episodes) as episodes"
                " from factory_orders\n```\n<BigValue data={caps} value=episodes />"
            },
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["results"]["caps"]["rows"] == [[2, 200.0]]

        # Org B sees neither the dataset nor the view.
        assert client.get(
            "/api/v1/datasets", headers={"x-api-key": "key-b-writer"}
        ).json() == []
        foreign = client.post(
            "/api/v1/query/sql",
            headers={"x-api-key": "key-b-writer"},
            json={"sql": "select * from factory_orders"},
        )
        assert foreign.status_code == 422


def test_dataset_door_fails_closed(rig: tuple[TestClient, FakeMetricStore]) -> None:
    client, _ = rig
    with client:
        reserved = client.put(
            "/api/v1/datasets/metrics",
            headers={"x-api-key": "key-a-writer"},
            json={"columns": [{"name": "x", "type": "number"}], "rows": [[1]]},
        )
        assert reserved.status_code == 422
        assert reserved.json()["detail"]["code"] == "invalid_dataset"

        ragged = client.put(
            "/api/v1/datasets/ok_name",
            headers={"x-api-key": "key-a-writer"},
            json={"columns": [{"name": "x", "type": "number"}], "rows": [[1, 2]]},
        )
        assert ragged.status_code == 422
        assert ragged.json()["detail"]["code"] == "invalid_dataset"

        bad_name = client.put(
            "/api/v1/datasets/Nope-Bad",
            headers={"x-api-key": "key-a-writer"},
            json={"columns": [{"name": "x", "type": "number"}], "rows": [[1]]},
        )
        assert bad_name.status_code == 422
