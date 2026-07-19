"""Postgres access: async pool for the API plus the numbered-SQL migrations
runner (house style: hand-written SQL, no ORM — the catalog pattern)."""

from __future__ import annotations

from importlib import resources
from pathlib import Path

import psycopg
from psycopg_pool import AsyncConnectionPool

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


def make_pool(dsn: str) -> AsyncConnectionPool:
    """The API's connection pool; opened/closed by the app lifespan."""
    return AsyncConnectionPool(dsn, min_size=1, max_size=8, open=False)


def connect(dsn: str) -> psycopg.Connection[tuple[object, ...]]:
    """One sync connection (worker, migrations, tools)."""
    return psycopg.connect(dsn)


def migrate(dsn: str) -> list[str]:
    """Apply pending numbered migrations; returns the filenames applied.

    Tracked in ``schema_migrations``; each file runs in ONE runner-owned
    transaction (files must not contain BEGIN/COMMIT), in filename order.
    Migrations are append-only once deployed — never edited.
    """
    applied: list[str] = []
    with connect(dsn) as conn:
        conn.autocommit = True
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename   text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        done = {row[0] for row in conn.execute("SELECT filename FROM schema_migrations").fetchall()}
        for path in sorted(_migration_files()):
            if path.name in done:
                continue
            sql = path.read_text()
            with conn.transaction():
                conn.execute(sql)  # type: ignore[arg-type]  # migrations are trusted files
                conn.execute("INSERT INTO schema_migrations (filename) VALUES (%s)", (path.name,))
            applied.append(path.name)
    return applied


def _migration_files() -> list[Path]:
    if MIGRATIONS_DIR.is_dir():
        return [p for p in MIGRATIONS_DIR.iterdir() if p.suffix == ".sql"]
    # Installed-wheel fallback: migrations ship as package data.
    pkg = resources.files("waddle_server") / "migrations"
    return [Path(str(p)) for p in pkg.iterdir() if str(p).endswith(".sql")]  # pragma: no cover
