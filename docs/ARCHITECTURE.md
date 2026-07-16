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
durability. Evidence dashboards query the `evidence_run_metrics` view; the example under
`evidence/` is intentionally separate from the Python package and its built-in live view.
