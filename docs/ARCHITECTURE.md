# Architecture

Waddle records experiment facts; dashboards are replaceable projections. Training jobs
always keep a local append-only journal and may mirror into Waddle. DuckDB contains run,
metric, worker, lineage, and artifact-reference metadata. Checkpoints, Rerun recordings,
media, and other large artifacts live in object storage and are referenced by URI and
SHA-256 rather than stored as database blobs.

Each process has an explicit `(run_id, rank, attempt)` identity. Aggregate metrics may be
written by rank zero while per-rank system/performance telemetry retains its origin. A retry
increments `attempt`; it must never overwrite an earlier attempt.

The local DuckDB file is the supported initial deployment. Quack remote transport is planned
behind the same writer API after its beta protocol stabilizes. It is not required for local
durability.

Dashboards are replaceable projections over the `evidence_*` views (`_schema.py`), which
remain the SQL analysis contract over a spool DB. Two projections have already been
replaced: the built-in Starlette/Plotly server, then the Evidence.dev project (deleted
2026-07-19). Today the projections are the hosted console
(`ui/`) over the synced platform data, and — laptop-local — agents querying the views
directly over a lock-free snapshot (the glued `waddle-dashboard` skill).
