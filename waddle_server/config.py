"""Settings for the waddle platform server (env prefix ``WADDLE_``) — the one
env-reading place."""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class WaddleSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WADDLE_")

    # Postgres (its own database on the shared cluster — db-per-app).
    pg_dsn: str = "postgresql://sxd:sxd@127.0.0.1:5433/waddle"

    # ClickHouse (the shared dev single node; database-per-app).
    ch_url: str = "http://127.0.0.1:8124"
    ch_user: str = "waddle"
    ch_password: str = "waddle"
    ch_database: str = "waddle"
    # Raw point/log retention; the Parquet layer on R2 outlives ClickHouse TTLs.
    ch_metric_ttl_days: int = 180
    ch_log_ttl_days: int = 90

    # Object store: the waddle-owned bucket (R2 in prod, MinIO in dev).
    s3_endpoint: str = "http://127.0.0.1:9010"
    s3_access_key: str = "dev"
    s3_secret_key: str = "dev12345"
    bucket: str = "sx-waddle"
    presign_ttl_s: int = 600
    # Dev/MinIO only: create the bucket at startup (R2 is provisioned out-of-band).
    ensure_bucket: bool = False
    upload_session_ttl_s: int = 3600

    # Central auth service (sx_authd): identity is introspected, never stored here.
    auth_url: str = "http://127.0.0.1:8300"
    auth_service_key: str = "sxk_waddle_introspect_dev"
    # Prod: require a credential on every request (401 otherwise). Dev default off:
    # unauthenticated requests resolve to the dev org admin without touching sx_authd.
    auth_required: bool = False

    # Ingest guardrails (org_limits rows override per org).
    ingest_rpm: int = 600
    max_points_per_batch: int = 5000
    max_batch_bytes: int = 8 * 1024 * 1024

    # Query guardrails.
    max_query_runs: int = 50
    max_query_metrics: int = 20
    max_query_points: int = 3000
    ch_max_execution_time_s: int = 30
    ch_max_memory_bytes: int = 2 * 1024**3

    # Built SPA to serve (the glued SPA-mount pattern); unset = API-only.
    ui_dist: Path | None = None
