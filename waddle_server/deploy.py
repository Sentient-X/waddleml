"""Explicit Waddle schema and development-bucket deployment job."""

from __future__ import annotations

import asyncio

from sx_service.logging import configure_logging, get_logger
from sx_service.storage import ObjectStore

from .config import WaddleSettings
from .server.db import MIGRATIONS
from .server.ch import deploy_schema

log = get_logger(__name__)


def main() -> None:
    configure_logging(service="waddle-deploy", force=True)
    settings = WaddleSettings()
    applied = MIGRATIONS.apply(settings.pg_dsn)
    if applied:
        log.info("migrations_applied", files=applied)
    asyncio.run(deploy_schema(settings))
    log.info("clickhouse_schema_reconciled", replicated=settings.ch_replicated)
    if settings.ensure_bucket:
        ObjectStore(settings.object_store).ensure_bucket()
        log.info("development_bucket_reconciled", bucket=settings.bucket)


if __name__ == "__main__":
    main()
