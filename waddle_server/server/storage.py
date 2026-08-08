"""The waddle bucket's key layout, and the one Parquet writer above it.

The client itself is `sx_service.storage` — this module says only what is true
of *this* bucket: where an org's bytes go, and which dataset names the SQL
sandbox will admit as views.

Org isolation lives in the prefix, so the SQL sandbox and any scoped credential
see exactly one org's subtree::

    orgs/{org_id}/blobs/sha256/{2ch}/{digest}
    orgs/{org_id}/parquet/{metrics|logs|runs|params}/...

The control plane never proxies artifact bytes: it presigns PUTs and GETs.
Uploads are single presigned PUTs (R2 allows up to 5 GB per object); the shared
store's multipart family is the recorded scale-up path if checkpoints outgrow
that.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from uuid import UUID

import duckdb

#: The dataset-name law: a name under orgs/{org}/parquet/ becomes a SQL view in
#: the sandbox, so the alphabet is deliberately identifier-narrow.
DATASET_NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,63}")

#: Datasets owned by the platform itself (the compactor's exports and the live
#: runs snapshot); producer uploads may not shadow them.
RESERVED_DATASETS = frozenset({"metrics", "logs", "runs"})


def blob_key(org_id: UUID, sha256: str) -> str:
    return f"orgs/{org_id}/blobs/sha256/{sha256[:2]}/{sha256}"


def parquet_key(org_id: UUID, dataset: str, partition: str) -> str:
    return f"orgs/{org_id}/parquet/{dataset}/{partition}.parquet"


def org_parquet_prefix(org_id: UUID) -> str:
    """Everything the sandbox may stage for one org — the security boundary."""
    return f"orgs/{org_id}/parquet/"


def write_parquet(
    rows: Sequence[Sequence[Any]], columns: list[tuple[str, str]], dest: Path
) -> None:
    """Rows + (name, DuckDB type) columns → one Parquet file. DuckDB does the
    writing (Arrow in → COPY TO parquet), keeping the substrate free of a
    pandas/pyarrow dependency. Shared by the compactor, the datasets door, and
    the sandbox's runs snapshot."""
    conn = duckdb.connect()
    try:
        ddl = ", ".join(f'"{name}" {kind}' for name, kind in columns)
        conn.execute(f"CREATE TABLE export ({ddl})")
        if rows:
            placeholders = ", ".join("?" for _ in columns)
            conn.executemany(f"INSERT INTO export VALUES ({placeholders})", rows)
        conn.execute(f"COPY export TO '{dest}' (FORMAT parquet)")
    finally:
        conn.close()
