"""Explicit Waddle schema and development-bucket deployment job."""

from __future__ import annotations

import asyncio

from sx_observability import configure_logging, get_logger

from .config import WaddleSettings
from .server import db
from .server.ch import deploy_schema
from .server.storage import ObjectStore

log = get_logger(__name__)


def main() -> None:
    configure_logging(service="waddle-deploy", force=True)
    settings = WaddleSettings()
    applied = db.migrate(settings.pg_dsn)
    if applied:
        log.info("migrations_applied", files=applied)
    asyncio.run(deploy_schema(settings))
    log.info("clickhouse_schema_reconciled", replicated=settings.ch_replicated)
    if settings.ensure_bucket:
        ObjectStore(settings).ensure_bucket()
        log.info("development_bucket_reconciled", bucket=settings.bucket)


if __name__ == "__main__":
    main()
