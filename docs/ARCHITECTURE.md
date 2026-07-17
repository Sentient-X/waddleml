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

The dashboard is the Evidence.dev project under `evidence/`, querying the `evidence_*` views
(`_schema.py`): the runs overview, a per-run deep dive generated for every run, and multi-run
comparison. `waddle dashboard` snapshots the DuckDB and serves it, refreshing the snapshot on
an interval so the dashboard tracks a running job without contending for DuckDB's writer lock.
Dashboards are replaceable projections over the views — the built-in Starlette/Plotly server
that once played this role was retired in favor of this SQL-native surface.
