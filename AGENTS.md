# Repository Guidelines

## Project Structure & Module Organization

Core package resides in `waddle/` with a modular architecture:

| Module | Purpose |
|--------|---------|
| `__init__.py` | Public API: `init`, `log`, `finish`, `log_artifact`, `log_param`, `log_tag` |
| `_api.py` | Module-level API — manages global active run |
| `_run.py` | `Run` class — metric batching, context manager, atexit |
| `_state.py` | Thread-safe global run state |
| `_db.py` | `WaddleDB` — DuckDB connection + thread-safe queries |
| `_schema.py` | DuckDB DDL (7 tables + the `evidence_*` dashboard views) |
| `_git.py` | Git detection + auto-snapshot (optional, never required) |
| `_sysmetrics.py` | `SystemMonitor` background thread (CPU/mem/GPU) |
| `_types.py` | `RepoInfo`/`WorkerInfo` dataclasses |
| `_sync.py` | `SyncEngine` — background upload of the DuckDB spool to the hosted platform (idempotent batches, persisted outbox, artifact uploads); active only when `WADDLE_API_URL`/`WADDLE_API_KEY` are set |
| `cli.py` | CLI entry point: `init`, `ls`, `dashboard`, `sync` |

The dashboard is an Evidence.dev project in `evidence/` (SQL + markdown over the
`evidence_*` views), launched by `waddle dashboard`. There is no in-process web server —
the old Starlette/WebSocket + Plotly dashboard (`_server.py`, `_dashboard_api.py`,
`static/index.html`) was retired.

The repo's second half is the **hosted platform**: `waddle_server/` (FastAPI control
plane :8400 over Postgres + ClickHouse + R2, the compaction worker, the org-jailed
DuckDB SQL sandbox, and the `waddle.*` MCP server :8410) and `ui/` (the console,
:5179). Server code is py3.12/pyright-strict and resolves only inside the glued
workspace (`server` extra); the SDK stays py3.9 + duckdb-only — `tests/test_purity.py`
pins both budgets.

Examples live in `examples/` and tests in `tests/`. Runtime artifacts (`.waddle/waddle.duckdb`) are generated during runs and should remain untracked.

## Build, Test, and Development Commands

- `python3 -m venv .venv && source .venv/bin/activate` — set up a local Python 3.9+ environment.
- `pip install -e ".[all]"` — install the package in editable mode with all optional deps (psutil, pynvml).
- `pytest tests/` — run the test suite.
- `python examples/quickstart.py` — emit sample runs for manual verification.
- `waddle ls` — list recent runs in terminal.
- `waddle dashboard` — snapshot the DuckDB and serve the Evidence dashboard (Node ≥18; first run installs `evidence/node_modules`).

## Coding Style & Naming Conventions

Follow PEP 8 with 4-space indentation, snake_case for functions and modules, CamelCase for public classes (`Run`, `WaddleDB`, `SystemMonitor`). Internal modules use a leading underscore (`_api.py`, `_run.py`, etc.). Keep functions cohesive and favor explicit type hints on public surfaces.

## Testing Guidelines

Tests live under `tests/` (`test_waddle.py`, `test_api.py`, `test_sysmetrics.py`). Run with `pytest tests/`. Use temporary directories and disposable DuckDB paths for isolation. Tests should be deterministic and offline-safe. Mock external dependencies like psutil/pynvml where needed.

## Commit & Pull Request Guidelines

Keep commit subjects short and imperative, under 72 characters. Bundle related changes together. Pull requests should summarize intent, list verification steps, and include screenshots for UI changes.

## Configuration Notes

All data is stored locally in `.waddle/waddle.duckdb` (single DuckDB file, no server process). The `.waddle/` directory is created automatically by `waddle.init()` or `waddle init`. Git integration is optional — waddle works anywhere, with or without a git repo.
