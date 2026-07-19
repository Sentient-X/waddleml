# waddle/ — Package Internals

## Module Map

| Module | Purpose |
|--------|---------|
| `__init__.py` | Public API: `init`, `log`, `finish`, `log_artifact`, `log_param`, `log_tag` |
| `_api.py` | Module-level API — manages global active run |
| `_run.py` | `Run` class — metric batching, context manager, atexit |
| `_state.py` | Thread-safe global run state |
| `_db.py` | `WaddleDB` — DuckDB connection + thread-safe queries |
| `_schema.py` | DuckDB DDL |
| `_git.py` | Git detection + auto-snapshot (optional, never required) |
| `_sysmetrics.py` | `SystemMonitor` background thread |
| `_types.py` | `RepoInfo` dataclass |
| `cli.py` | CLI: `init`, `ls`, `sync` |

There is no in-process web server and no local dashboard command. The `evidence_*`
views in `_schema.py` are the SQL analysis contract over a spool DB (consumed by the
glued `waddle-dashboard` agent skill). The Evidence.dev dashboard was deleted
2026-07-19, the old Starlette/WebSocket one before that.

## Data Flow

```
waddle.init() → _api.py → _db.py (DuckDB) → _run.py (Run object)
                  ↓                              ↓
             _git.py (optional)           _sysmetrics.py
             auto-detect + snapshot       background thread

waddle.log()      → _state.py (active run) → _run.py → DuckDB metrics table
waddle sync       → cli.py → _sync.py → hosted platform (idempotent batches)
```
