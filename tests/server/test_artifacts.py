"""Artifact contract: session → blob → commit → version/lineage; org-scoped
content addressing; conflict semantics."""

from __future__ import annotations

import hashlib
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from waddle_server.server.storage import blob_key

from .conftest import ORG_A, FakeMetricStore, FakeObjectStore, requires_dev_postgres
from .test_ingest_contract import _create_run

pytestmark = requires_dev_postgres

BLOB = b"checkpoint bytes"
SHA = hashlib.sha256(BLOB).hexdigest()


def _open_session(client: TestClient, key: str):
    return client.post(
        "/api/v1/artifacts/upload-sessions",
        headers={"x-api-key": key},
        json={
            "files": [
                {"logical_path": "model.safetensors", "sha256": SHA, "size_bytes": len(BLOB)}
            ]
        },
    )


def test_upload_commit_lineage_roundtrip(
    rig: tuple[TestClient, FakeMetricStore], blobs: FakeObjectStore
) -> None:
    client, _ = rig
    with client:
        run_id = uuid4().hex
        _create_run(client, "key-a-writer", run_id)

        session = _open_session(client, "key-a-writer").json()
        target = session["targets"][0]
        assert target["url"] is not None  # new blob → presigned PUT offered
        # Simulate the client's PUT landing in the store.
        blobs.objects[blob_key(ORG_A.id, SHA)] = BLOB

        committed = client.post(
            f"/api/v1/artifacts/upload-sessions/{session['session_id']}/commit",
            headers={"x-api-key": "key-a-writer"},
            json={"collection": "policy", "project": "demo", "kind": "model", "run_id": run_id},
        )
        assert committed.status_code == 201
        version = committed.json()
        assert version["collection"] == "policy" and version["version"] == 0
        assert version["files"][0]["sha256"] == SHA
        assert version["files"][0]["download_url"].startswith("https://fake/")

        lineage = client.get(
            f"/api/v1/runs/{run_id}/lineage", headers={"x-api-key": "key-a-reader"}
        ).json()
        assert lineage == [
            {
                "run_id": run_id,
                "relation": "output",
                "collection": "policy",
                "version": 0,
                "artifact_id": version["id"],
            }
        ]

        # Same-org dedup: a second session for the same blob offers no PUT.
        again = _open_session(client, "key-a-writer").json()
        assert again["targets"][0]["url"] is None

        # Content identity: committing identical content from another run
        # reuses the version (200, still v0), keeps the producer's provenance,
        # and still records the second run's output edge.
        run_b = uuid4().hex
        _create_run(client, "key-a-writer", run_b)
        reused = client.post(
            f"/api/v1/artifacts/upload-sessions/{again['session_id']}/commit",
            headers={"x-api-key": "key-a-writer"},
            json={"collection": "policy", "project": "demo", "kind": "model", "run_id": run_b},
        )
        assert reused.status_code == 200
        assert reused.json()["id"] == version["id"] and reused.json()["version"] == 0
        assert reused.json()["created_by_run_id"] == run_id
        b_lineage = client.get(
            f"/api/v1/runs/{run_b}/lineage", headers={"x-api-key": "key-a-reader"}
        ).json()
        assert [(e["relation"], e["artifact_id"]) for e in b_lineage] == [
            ("output", version["id"])
        ]

        # An input edge (use_artifact): the consuming run's commit records
        # relation=input against the same version and never claims created_by.
        run_c = uuid4().hex
        _create_run(client, "key-a-writer", run_c)
        use_session = _open_session(client, "key-a-writer").json()
        used = client.post(
            f"/api/v1/artifacts/upload-sessions/{use_session['session_id']}/commit",
            headers={"x-api-key": "key-a-writer"},
            json={
                "collection": "policy",
                "project": "demo",
                "kind": "model",
                "run_id": run_c,
                "relation": "input",
            },
        )
        assert used.status_code == 200
        assert used.json()["id"] == version["id"]
        assert used.json()["created_by_run_id"] == run_id
        c_lineage = client.get(
            f"/api/v1/runs/{run_c}/lineage", headers={"x-api-key": "key-a-reader"}
        ).json()
        assert [(e["relation"], e["artifact_id"]) for e in c_lineage] == [
            ("input", version["id"])
        ]

        # Aliases move; the artifact resolves for readers.
        assert (
            client.post(
                f"/api/v1/artifacts/{version['id']}/aliases",
                headers={"x-api-key": "key-a-writer"},
                json={"alias": "best"},
            ).status_code
            == 204
        )
        got = client.get(
            f"/api/v1/artifacts/{version['id']}", headers={"x-api-key": "key-a-reader"}
        )
        assert got.status_code == 200 and got.json()["digest"] == version["digest"]


def test_commit_requires_uploaded_blob_and_org_isolation(
    rig: tuple[TestClient, FakeMetricStore], blobs: FakeObjectStore
) -> None:
    client, _ = rig
    with client:
        # Commit without the blob landing → 409, nothing versioned.
        session = _open_session(client, "key-a-writer").json()
        missing = client.post(
            f"/api/v1/artifacts/upload-sessions/{session['session_id']}/commit",
            headers={"x-api-key": "key-a-writer"},
            json={"collection": "policy", "project": "demo"},
        )
        assert missing.status_code == 409

        # Org B's identical content lives under ITS prefix: no cross-org dedup
        # (a fresh PUT is offered) and org A's artifacts are invisible to B.
        blobs.objects[blob_key(ORG_A.id, SHA)] = BLOB
        b_session = _open_session(client, "key-b-writer").json()
        assert b_session["targets"][0]["url"] is not None

        blobs.objects[blob_key(UUID(int=0xB), SHA)] = BLOB
        b_commit = client.post(
            f"/api/v1/artifacts/upload-sessions/{b_session['session_id']}/commit",
            headers={"x-api-key": "key-b-writer"},
            json={"collection": "policy", "project": "demo"},
        )
        assert b_commit.status_code == 201
        foreign = client.get(
            f"/api/v1/artifacts/{b_commit.json()['id']}", headers={"x-api-key": "key-a-reader"}
        )
        assert foreign.status_code == 404
