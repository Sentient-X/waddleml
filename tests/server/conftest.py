"""Server test rig: throwaway Postgres database (skipped when the dev cluster
is down — the catalog pattern), an in-memory MetricStore, and a stub AuthClient
minting two synthetic orgs so company isolation is exercised through the real
auth path."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

import pytest

psycopg = pytest.importorskip("psycopg")
pytest.importorskip("fastapi")

from fastapi.testclient import TestClient  # noqa: E402
from sx_auth.client import AuthClient  # noqa: E402
from sx_auth.principal import (  # noqa: E402
    CredentialInfo,
    CredentialKind,
    GrantRecord,
    IntrospectionResult,
    OrgKind,
    OrgRef,
    Principal,
    PrincipalKind,
)

from waddle_server.config import WaddleSettings  # noqa: E402
from waddle_server.server import quotas  # noqa: E402
from waddle_server.server.app import build_app  # noqa: E402
from waddle_server.server.ch import (  # noqa: E402
    LatestMetric,
    LogLine,
    MetricStore,
    SeriesPoint,
)
from waddle_server.server.storage import HeadInfo, ObjectStore  # noqa: E402

ADMIN_DSN = "postgresql://sxd:sxd@127.0.0.1:5433/postgres"
TEST_DB = "waddle_test"

ORG_A = OrgRef(id=UUID(int=0xA), slug="org-a", kind=OrgKind.CUSTOMER)
ORG_B = OrgRef(id=UUID(int=0xB), slug="org-b", kind=OrgKind.CUSTOMER)

#: raw key -> (org, waddle role); "stale" keys are unknown (401).
KEYS: dict[str, tuple[OrgRef, str]] = {
    "key-a-writer": (ORG_A, "writer"),
    "key-a-reader": (ORG_A, "reader"),
    "key-b-writer": (ORG_B, "writer"),
}


def _dev_postgres_available() -> bool:
    try:
        with psycopg.connect(ADMIN_DSN, connect_timeout=2):
            return True
    except psycopg.OperationalError:
        return False


requires_dev_postgres = pytest.mark.skipif(
    not _dev_postgres_available(),
    reason="dev Postgres (:5433, infra/docker-compose.dev.yml) is not running",
)


class StubAuthClient(AuthClient):
    """Resolves the synthetic KEYS table instead of calling sx_authd."""

    def __init__(self) -> None:
        super().__init__(base_url="http://stub", service_key="stub", audience="waddle")

    async def introspect_api_key(self, raw: str) -> IntrospectionResult | None:
        entry = KEYS.get(raw)
        if entry is None:
            return None
        org, role = entry
        return IntrospectionResult(
            principal=Principal(
                id=uuid4(),
                kind=PrincipalKind.SERVICE,
                subject=f"{org.slug}-{role}",
                display_name=f"{org.slug} {role}",
                org=org,
                grants=(GrantRecord(scope="*", role=role),),
            ),
            credential=CredentialInfo(id=uuid4(), kind=CredentialKind.API_KEY),
            cache_ttl_s=30,
        )

    async def introspect_session(self, token: str) -> IntrospectionResult | None:
        return await self.introspect_api_key(token)


class FakeMetricStore(MetricStore):
    """In-memory stand-in matching MetricStore's query semantics closely enough
    for contract tests (attempt-dedup + bucketing); the real ClickHouse path is
    covered by test_ch_integration.py against the dev compose node."""

    def __init__(self) -> None:
        super().__init__(WaddleSettings())
        self.metrics: list[tuple[object, ...]] = []
        self.logs: list[tuple[object, ...]] = []

    async def open(self) -> None:  # no ClickHouse
        pass

    async def close(self) -> None:
        pass

    async def insert_metrics(self, rows: list[tuple[object, ...]]) -> None:
        self.metrics.extend(rows)

    async def insert_logs(self, rows: list[tuple[object, ...]]) -> None:
        self.logs.extend(rows)

    async def series(
        self,
        org_id: UUID,
        *,
        run_ids: list[str],
        metric_names: list[str],
        step_min: int | None,
        step_max: int | None,
        max_points: int,
    ) -> list[SeriesPoint]:
        latest_attempt: dict[tuple[str, str, int], tuple[int, float, datetime]] = {}
        for row in self.metrics:
            (org, _proj, run, name, step, ts, value, _rank, _node, attempt, *_rest) = row
            if org != org_id or run not in run_ids:
                continue
            if metric_names and name not in metric_names:
                continue
            if step_min is not None and int(str(step)) < step_min:
                continue
            if step_max is not None and int(str(step)) > step_max:
                continue
            key = (str(run), str(name), int(str(step)))
            current = latest_attempt.get(key)
            if current is None or int(str(attempt)) >= current[0]:
                latest_attempt[key] = (int(str(attempt)), float(str(value)), ts)  # type: ignore[arg-type]
        if not latest_attempt:
            return []
        steps = [step for (_r, _m, step) in latest_attempt]
        width = max(1, (max(steps) - min(steps) + 1) // max_points)
        buckets: dict[tuple[str, str, int], list[tuple[float, datetime]]] = {}
        for (run, name, step), (_a, value, ts) in latest_attempt.items():
            buckets.setdefault((run, name, step // width * width), []).append((value, ts))
        return sorted(
            (
                SeriesPoint(
                    run_id=run,
                    metric_name=name,
                    step=step,
                    value=sum(v for v, _ in vals) / len(vals),
                    value_min=min(v for v, _ in vals),
                    value_max=max(v for v, _ in vals),
                    ts=max(ts for _, ts in vals),
                )
                for (run, name, step), vals in buckets.items()
            ),
            key=lambda p: (p.run_id, p.metric_name, p.step),
        )

    async def latest(self, org_id: UUID, *, run_ids: list[str]) -> list[LatestMetric]:
        best: dict[tuple[str, str], tuple[int, int, float, datetime]] = {}
        for row in self.metrics:
            (org, _proj, run, name, step, ts, value, _rank, _node, attempt, *_rest) = row
            if org != org_id or run not in run_ids:
                continue
            key = (str(run), str(name))
            candidate = (int(str(attempt)), int(str(step)), float(str(value)), ts)
            if key not in best or candidate[:2] >= best[key][:2]:
                best[key] = candidate  # type: ignore[assignment]
        return [
            LatestMetric(run_id=run, metric_name=name, value=value, step=step, ts=ts)
            for (run, name), (_a, step, value, ts) in sorted(best.items())
        ]

    async def logs_tail(
        self, org_id: UUID, *, run_id: str, after_ts: datetime | None, limit: int
    ) -> list[LogLine]:
        lines = [
            LogLine(run_id=str(row[2]), ts=row[3], level=str(row[4]), source=str(row[5]), message=str(row[6]))  # type: ignore[arg-type]
            for row in self.logs
            if row[0] == org_id and row[2] == run_id
            and (after_ts is None or row[3] > after_ts)  # type: ignore[operator]
        ]
        return lines[-limit:]


class FakeObjectStore(ObjectStore):
    """In-memory blob store: presigned URLs become dict writes the test seeds."""

    def __init__(self) -> None:  # deliberately no boto3 client
        self._settings = WaddleSettings()
        self.objects: dict[str, bytes] = {}

    def head(self, key: str) -> HeadInfo | None:
        blob = self.objects.get(key)
        return None if blob is None else HeadInfo(size_bytes=len(blob))

    def presign_get(self, key: str) -> str:
        return f"https://fake/{key}"

    def presign_put(self, key: str) -> str:
        return f"https://fake-put/{key}"

    def get_bytes(self, key: str) -> bytes:
        return self.objects[key]

    def put_file_replace(self, path, key: str) -> None:
        self.objects[key] = path.read_bytes()

    def list_keys(self, prefix: str):
        return (key for key in sorted(self.objects) if key.startswith(prefix))

    def list_objects(self, prefix: str):
        from hashlib import sha256

        from waddle_server.server.storage import ObjectInfo

        for key in sorted(self.objects):
            if key.startswith(prefix):
                yield ObjectInfo(key=key, etag=sha256(self.objects[key]).hexdigest()[:16])

    def ensure_bucket(self) -> None:
        pass


@pytest.fixture()
def fresh_db() -> str:
    with psycopg.connect(ADMIN_DSN, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {TEST_DB} (FORCE)")
        conn.execute(f"CREATE DATABASE {TEST_DB}")
    return f"postgresql://sxd:sxd@127.0.0.1:5433/{TEST_DB}"


@pytest.fixture()
def blobs() -> FakeObjectStore:
    return FakeObjectStore()


@pytest.fixture()
def rig(fresh_db: str, blobs: FakeObjectStore) -> tuple[TestClient, FakeMetricStore]:
    quotas.reset()
    store = FakeMetricStore()
    app = build_app(
        settings=WaddleSettings(pg_dsn=fresh_db, auth_required=True),
        auth_client=StubAuthClient(),
        metric_store=store,
        object_store=blobs,
    )
    return TestClient(app), store
