"""The sqlbox staging cache: ETag-keyed reuse, invalidation, bounded size."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from waddle_server.server.storage import ObjectInfo  # noqa: E402
from waddle_server.sqlbox import StagingCache  # noqa: E402


class _CountingStore:
    def __init__(self, blobs: dict[str, bytes]) -> None:
        self.blobs = blobs
        self.fetches: list[str] = []

    def get_bytes(self, key: str) -> bytes:
        self.fetches.append(key)
        return self.blobs[key]


def test_unchanged_objects_download_once(tmp_path: Path) -> None:
    store = _CountingStore({"orgs/x/parquet/metrics/m.parquet": b"payload"})
    cache = StagingCache(tmp_path, max_bytes=1 << 20)
    obj = ObjectInfo(key="orgs/x/parquet/metrics/m.parquet", etag="v1")

    first = cache.fetch(store, obj)  # type: ignore[arg-type]
    second = cache.fetch(store, obj)  # type: ignore[arg-type]
    assert first == second and first.read_bytes() == b"payload"
    assert store.fetches == ["orgs/x/parquet/metrics/m.parquet"]  # one download

    # A replaced snapshot (new ETag) refetches; the old blob stays until pruned.
    store.blobs["orgs/x/parquet/metrics/m.parquet"] = b"payload-2"
    third = cache.fetch(store, ObjectInfo(key=obj.key, etag="v2"))  # type: ignore[arg-type]
    assert third != first and third.read_bytes() == b"payload-2"
    assert len(store.fetches) == 2


def test_prune_bounds_the_cache(tmp_path: Path) -> None:
    store = _CountingStore({f"k{i}": bytes(400) for i in range(8)})
    cache = StagingCache(tmp_path, max_bytes=1000)
    for i in range(8):
        cache.fetch(store, ObjectInfo(key=f"k{i}", etag="e"))  # type: ignore[arg-type]
    kept = [p for p in tmp_path.iterdir() if p.is_file()]
    assert sum(p.stat().st_size for p in kept) <= 1000
    assert kept  # bounded, never emptied to zero by a single insert
