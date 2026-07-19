# Architecture

Waddle records experiment facts; dashboards are replaceable projections. Training jobs
always keep a local append-only journal and may mirror into Waddle. DuckDB contains run,
metric, worker, lineage, and artifact-reference metadata. Checkpoints, Rerun recordings,
media, and other large artifacts live in object storage and are referenced by URI and
SHA-256 rather than stored as database blobs.

Each process has an explicit `(run_id, rank, attempt)` identity. Aggregate metrics may be
written by rank zero while per-rank system/performance telemetry retains its origin. A retry
increments `attempt`; it must never overwrite an earlier attempt.

Autoresearch uses the same run grain rather than a parallel node store. One campaign is a
`group_name`; every evaluated candidate is a run with `job_type=autoresearch` and one typed
`ResearchTrial` record (trial index, objective/direction, hypothesis, optional parent run). This
means failures, workers, metrics, git identity, logs, artifacts, sync, and org isolation keep their
existing semantics. The incumbent curve and experiment tree are read-time projections. Waddle
never proposes code or decides whether a candidate wins; those remain controller responsibilities.

The local DuckDB file is the supported initial deployment. Quack remote transport is planned
behind the same writer API after its beta protocol stabilizes. It is not required for local
durability.

Dashboards are replaceable projections over the `evidence_*` views (`_schema.py`), which
remain the SQL analysis contract over a spool DB. Two projections have already been
replaced: the built-in Starlette/Plotly server, then the Evidence.dev project (deleted
2026-07-19). Today the projections are the hosted console
(`ui/`) over the synced platform data, and — laptop-local — agents querying the views
directly over a lock-free snapshot (the glued `waddle-dashboard` skill).

Hosted, the Evidence idea returns rederived as **reports as code**
(`waddle_server/reports.py`): org-scoped markdown documents (named SQL fences,
`${query}` chaining as parenthesized-subquery substitution, `${params.x}`, component
tags) compiled to a typed query DAG — cycles and unknown references fail closed at
save — and rendered by executing every query in one pass of the org-jailed SQL
sandbox. Evidence is safe splicing text into SQL only because its queries run in the
author's own client-local DuckDB; the sandbox is the server-side analog of that law,
so the hosted dialect inherits the safety model by construction. The substrate is
open: `PUT /api/v1/datasets/{name}` lets any producer (the factory is the first)
publish tabular snapshots that instantly become views in the sandbox and in reports.
