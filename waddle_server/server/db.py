"""waddle's Postgres facts.

The pool and the migration runner are `sx_service`; what belongs to this service
is only *which* schema it owns and under which lock — so that is all this module
declares.
"""

from __future__ import annotations

from pathlib import Path

from sx_service.db import SqlMigrations

MIGRATIONS = SqlMigrations(
    ledger="schema_migrations",
    lock="waddle-server-migrations-v1",
    directory=Path(__file__).resolve().parents[1] / "migrations",
    package="waddle_server",
)
