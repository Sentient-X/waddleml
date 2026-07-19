"""Real-ClickHouse coverage of the query semantics (attempt dedup, decimation,
latest, log tail). Skips unless the dev compose node (:8124) is reachable —
part of `make check-waddle-full`, and of `make check` whenever dev infra is up.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

pytest.importorskip("clickhouse_connect")

import urllib.error  # noqa: E402
import urllib.request  # noqa: E402

from waddle_server.config import WaddleSettings  # noqa: E402
from waddle_server.server.ch import MetricStore  # noqa: E402


def _dev_clickhouse_available() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8124/ping", timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


pytestmark = pytest.mark.skipif(
    not _dev_clickhouse_available(),
    reason="dev ClickHouse (:8124, infra/docker-compose.dev.yml) is not running",
)

ORG = UUID(int=0xC0FFEE)


def _row(
    run_id: str,
    name: str,
    step: int,
    value: float,
    *,
    attempt: int = 0,
    seq: int,
    batch_id: UUID,
    writer_id: UUID,
) -> tuple[object, ...]:
    return (
        ORG,
        UUID(int=1),
        run_id,
        name,
        step,
        datetime.now(UTC),
        value,
        0,
        "node0",
        attempt,
        writer_id,
        batch_id,
        seq,
    )


async def _exercise() -> None:
    store = MetricStore(WaddleSettings())
    await store.open()
    try:
        run_id = uuid4().hex
        writer = uuid4()
        rows: list[tuple[object, ...]] = []
        batch = uuid4()
        for step in range(2000):
            rows.append(_row(run_id, "loss", step, 1.0 / (step + 1), seq=step, batch_id=batch, writer_id=writer))
        # A resume: attempt 1 rewrites steps 1000.. with different values — the
        # latest attempt must win in every query.
        batch2 = uuid4()
        for i, step in enumerate(range(1000, 1100)):
            rows.append(
                _row(run_id, "loss", step, 42.0, attempt=1, seq=2000 + i, batch_id=batch2, writer_id=writer)
            )
        await store.insert_metrics(rows)

        series = await store.series(
            ORG, run_ids=[run_id], metric_names=["loss"], step_min=None, step_max=None,
            max_points=100,
        )
        assert 0 < len(series) <= 100
        by_step = {p.step: p for p in series}
        # The bucket containing step 1000 reflects the attempt-1 rewrite.
        resumed_bucket = max(s for s in by_step if s <= 1000)
        assert by_step[resumed_bucket].value_max == 42.0

        latest = await store.latest(ORG, run_ids=[run_id])
        assert latest[0].step == 1999

        # Foreign org: nothing.
        assert await store.series(
            UUID(int=0xDEAD), run_ids=[run_id], metric_names=[], step_min=None,
            step_max=None, max_points=10,
        ) == []

        await store.insert_logs(
            [
                (ORG, UUID(int=1), run_id, datetime.now(UTC), "info", "loop", f"line {i}",
                 writer, uuid4(), i)
                for i in range(10)
            ]
        )
        tail = await store.logs_tail(ORG, run_id=run_id, after_ts=None, limit=5)
        assert len(tail) == 5 and tail[-1].message == "line 9"
    finally:
        await store.close()


def test_clickhouse_query_semantics() -> None:
    asyncio.run(_exercise())
