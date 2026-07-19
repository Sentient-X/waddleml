# pyright: basic
# (boto3 is unstubbed; strict Unknown checks drown this file — the catalog precedent)
"""Object-store access for the waddle bucket (R2 in prod, MinIO in dev).

The control plane never proxies artifact bytes: it presigns PUTs and GETs.
Uploads are single presigned PUTs (R2 allows up to 5 GB per object); multipart
is the recorded scale-up path if checkpoints outgrow that.

Key layout (org isolation lives in the prefix — the SQL sandbox and any scoped
credential see exactly one org's subtree):

    orgs/{org_id}/blobs/sha256/{2ch}/{digest}
    orgs/{org_id}/parquet/{metrics|logs|runs|params}/...
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import boto3
import duckdb
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from waddle_server.config import WaddleSettings

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


@dataclass(frozen=True, slots=True)
class HeadInfo:
    size_bytes: int


@dataclass(frozen=True, slots=True)
class ObjectInfo:
    """One listed object; ``etag`` is the content-version key the sqlbox
    staging cache invalidates on."""

    key: str
    etag: str


class ObjectStore:
    """Thin boto3 wrapper bound to the waddle bucket."""

    def __init__(self, settings: WaddleSettings) -> None:
        self._settings = settings
        self._client: Any = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            region_name="auto",
            config=BotoConfig(max_pool_connections=10),
        )

    @property
    def bucket(self) -> str:
        return self._settings.bucket

    def head(self, key: str) -> HeadInfo | None:
        try:
            response = self._client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as err:
            if err.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return None
            raise
        return HeadInfo(size_bytes=int(response["ContentLength"]))

    def presign_get(self, key: str) -> str:
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=self._settings.presign_ttl_s,
        )

    def presign_put(self, key: str) -> str:
        return self._client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=self._settings.presign_ttl_s,
        )

    def put_file(self, path: Path, key: str) -> None:
        """Idempotent write (content identity is in the key)."""
        if self.head(key) is not None:
            return
        self._client.upload_file(str(path), self.bucket, key)

    def put_file_replace(self, path: Path, key: str) -> None:
        """Overwriting write for the worker's Parquet partitions (their content
        legitimately changes as the month accrues; artifact blobs never use this)."""
        self._client.upload_file(str(path), self.bucket, key)

    def get_bytes(self, key: str) -> bytes:
        return self._client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def list_keys(self, prefix: str):
        yield from (obj.key for obj in self.list_objects(prefix))

    def list_objects(self, prefix: str):
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                yield ObjectInfo(key=obj["Key"], etag=str(obj.get("ETag", "")).strip('"'))

    def ensure_bucket(self) -> None:
        """Dev/MinIO convenience; R2 buckets are provisioned out-of-band."""
        try:
            self._client.head_bucket(Bucket=self.bucket)
        except ClientError:
            self._client.create_bucket(Bucket=self.bucket)
