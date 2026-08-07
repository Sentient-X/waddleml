"""Settings for the waddle platform server (env prefix ``WADDLE_``) — the one
env-reading place."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sx_service.registry import AUTH, AUTH_PUBLIC, TELEMETRY_INGEST


class WaddleSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WADDLE_")

    # Postgres (its own database on the shared cluster — db-per-app).
    pg_dsn: str = "postgresql://sxd:sxd@127.0.0.1:5433/waddle"

    # ClickHouse (the shared dev single node; database-per-app).
    ch_url: str = "http://127.0.0.1:8124"
    ch_user: str = "waddle"
    ch_password: str = "waddle"
    ch_database: str = "waddle"
    # Production supplies {shard}/{replica} macros and a Keeper quorum.
    # Development deliberately uses ordinary MergeTree on its one local node.
    ch_replicated: bool = False
    # Raw point/log retention; the Parquet layer on R2 outlives ClickHouse TTLs.
    ch_metric_ttl_days: int = 180
    ch_log_ttl_days: int = 90

    # Object store: the waddle-owned bucket (R2 in prod, MinIO in dev).
    s3_endpoint: str = "http://127.0.0.1:9010"
    s3_access_key: str = "dev"
    s3_secret_key: str = "dev12345"
    bucket: str = "sx-waddle"
    presign_ttl_s: int = 600
    # Dev/MinIO deployment job only (R2 is provisioned out-of-band).
    ensure_bucket: bool = False
    upload_session_ttl_s: int = 3600

    # Central auth service (sx_authd): identity is introspected, never stored here.
    # The address binds to the platform-canonical SX_AUTH_URL (sx-service registry).
    auth_url: str = Field(default=AUTH.dev_url, validation_alias=AUTH.env_var)
    # Where a BROWSER reaches sx_authd — not the same address this process uses.
    # The login view sets the session cookie host-scoped to the origin that
    # served it, and a browser treats 127.0.0.1 and localhost as different hosts,
    # so the internal address yields a cookie the console can never read.
    # Prod: internal service DNS above, public ingress here.
    auth_public_url: str = Field(
        default=AUTH_PUBLIC.dev_url, validation_alias=AUTH_PUBLIC.env_var
    )
    auth_service_key: str = "sxk_waddle_introspect_dev"
    # Require a credential on every request (401 otherwise). The default is ON so
    # that a deployment which forgets to set this locks down rather than serving
    # every org's runs to anyone; dev opts OUT explicitly (see Procfile.dev),
    # which resolves an unauthenticated request to the dev org admin without
    # touching sx_authd.
    auth_required: bool = True

    # Ingest guardrails (org_limits rows override per org).
    ingest_rpm: int = TELEMETRY_INGEST.requests_per_minute
    max_points_per_batch: int = 5000
    max_batch_bytes: int = 8 * 1024 * 1024

    # SQL-sandbox staging cache: org Parquet is fetched from the object store
    # into a local content-addressed cache (keyed by object ETag) and hardlinked
    # into each job's scratch dir, so repeated queries/renders re-download only
    # what changed. Unset dir → <system tmp>/waddle-sqlbox-cache.
    sqlbox_cache_dir: Path | None = None
    sqlbox_cache_max_bytes: int = 4 * 1024**3

    # Query guardrails.
    max_query_runs: int = 50
    max_query_metrics: int = 20
    max_query_points: int = 3000
    ch_max_execution_time_s: int = 30
    ch_max_memory_bytes: int = 2 * 1024**3

    # Built SPA to serve (the glued SPA-mount pattern); unset = API-only.
    ui_dist: Path | None = None
