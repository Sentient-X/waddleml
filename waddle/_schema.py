"""DuckDB DDL for the Waddle schema."""

SCHEMA_DDL = """\
CREATE TABLE IF NOT EXISTS repos (
    id VARCHAR PRIMARY KEY,
    name VARCHAR UNIQUE NOT NULL,
    path VARCHAR NOT NULL,
    origin_url VARCHAR,
    default_branch VARCHAR DEFAULT 'main',
    created_at DOUBLE NOT NULL
);

CREATE TABLE IF NOT EXISTS commits (
    repo_id VARCHAR NOT NULL REFERENCES repos(id),
    commit_sha VARCHAR NOT NULL,
    tree_sha VARCHAR,
    author VARCHAR,
    author_time DOUBLE,
    message VARCHAR,
    PRIMARY KEY (repo_id, commit_sha)
);

CREATE TABLE IF NOT EXISTS runs (
    id VARCHAR PRIMARY KEY,
    project VARCHAR NOT NULL DEFAULT 'default',
    repo_id VARCHAR,
    commit_sha VARCHAR,
    name VARCHAR,
    status VARCHAR NOT NULL DEFAULT 'running',
    started_at DOUBLE NOT NULL,
    ended_at DOUBLE,
    env JSON,
    config JSON,
    notes VARCHAR,
    lineage JSON
);

CREATE TABLE IF NOT EXISTS run_workers (
    run_id VARCHAR NOT NULL REFERENCES runs(id),
    rank INTEGER NOT NULL,
    local_rank INTEGER NOT NULL,
    world_size INTEGER NOT NULL,
    node_id VARCHAR NOT NULL,
    attempt INTEGER NOT NULL,
    started_at DOUBLE NOT NULL,
    PRIMARY KEY (run_id, rank, attempt)
);

CREATE TABLE IF NOT EXISTS params (
    run_id VARCHAR NOT NULL REFERENCES runs(id),
    key VARCHAR NOT NULL,
    value JSON NOT NULL,
    PRIMARY KEY (run_id, key)
);

CREATE TABLE IF NOT EXISTS tags (
    run_id VARCHAR NOT NULL REFERENCES runs(id),
    key VARCHAR NOT NULL,
    value JSON NOT NULL,
    PRIMARY KEY (run_id, key)
);

CREATE TABLE IF NOT EXISTS metrics (
    run_id VARCHAR NOT NULL,
    key VARCHAR NOT NULL,
    step INTEGER NOT NULL,
    ts DOUBLE NOT NULL,
    value DOUBLE NOT NULL,
    rank INTEGER NOT NULL DEFAULT 0,
    node_id VARCHAR NOT NULL DEFAULT 'localhost',
    attempt INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_metrics_run_key ON metrics(run_id, key, step);

CREATE TABLE IF NOT EXISTS artifacts (
    id VARCHAR PRIMARY KEY,
    run_id VARCHAR NOT NULL REFERENCES runs(id),
    name VARCHAR NOT NULL,
    kind VARCHAR NOT NULL DEFAULT 'file',
    created_at DOUBLE NOT NULL,
    uri VARCHAR,
    sha256 VARCHAR,
    size_bytes BIGINT,
    inline_bytes BLOB
);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS lineage JSON;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS repo_id VARCHAR;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS commit_sha VARCHAR;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS rank INTEGER DEFAULT 0;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS node_id VARCHAR DEFAULT 'localhost';
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS attempt INTEGER DEFAULT 0;


-- Views prefixed evidence_ are the read contract for the Evidence dashboard
-- (packages/waddleml/evidence/). They exist so dashboard pages — and agents
-- generating new pages — write plain SQL instead of re-deriving joins and JSON
-- extraction. Everything downstream reads these, never the raw tables.

-- Long metric stream joined to its run: one row per (run, key, step).
CREATE OR REPLACE VIEW evidence_run_metrics AS
SELECT r.project, r.id AS run_id, r.name AS run_name, r.status,
       r.started_at, r.ended_at, r.config, r.lineage,
       m.key, m.step, m.ts, m.value, m.rank, m.node_id, m.attempt
FROM runs r JOIN metrics m ON r.id = m.run_id;

-- One row per run: the overview-table and KPI grain. Duration falls back to the
-- last metric timestamp while a run is still running (no ended_at yet).
CREATE OR REPLACE VIEW evidence_runs AS
WITH latest AS (
    SELECT run_id,
           arg_max(value, step) FILTER (WHERE key = 'loss') AS latest_loss,
           arg_max(value, step) FILTER (WHERE key = 'lr') AS latest_lr,
           arg_max(value, step) FILTER (WHERE key = 'grad_norm') AS latest_grad_norm,
           max(step) FILTER (WHERE key = 'loss') AS total_steps,
           max(ts) AS last_ts,
           avg(value) FILTER (WHERE key = 'perf/samples_per_second') AS avg_samples_per_second,
           max(value) FILTER (WHERE key = 'perf/peak_reserved_bytes') AS peak_reserved_bytes
    FROM metrics GROUP BY run_id
),
worker AS (
    SELECT run_id, any_value(node_id) AS node_id, max(world_size) AS world_size
    FROM run_workers GROUP BY run_id
)
SELECT r.project, r.id AS run_id, r.name AS run_name, r.status,
       r.started_at, r.ended_at, r.commit_sha,
       COALESCE(r.ended_at, l.last_ts) - r.started_at AS duration_seconds,
       l.total_steps, l.latest_loss, l.latest_lr, l.latest_grad_norm,
       l.avg_samples_per_second,
       l.peak_reserved_bytes / 1e9 AS peak_reserved_gb,
       w.node_id, w.world_size
FROM runs r
LEFT JOIN latest l ON l.run_id = r.id
LEFT JOIN worker w ON w.run_id = r.id;

-- Latest value per (run, key) — powers KPI tiles and the run comparison table.
CREATE OR REPLACE VIEW evidence_run_metric_latest AS
SELECT run_id, key, arg_max(value, step) AS value, max(step) AS step
FROM metrics GROUP BY run_id, key;

-- Metric keys grouped into the three panels the dashboard renders separately.
CREATE OR REPLACE VIEW evidence_metric_keys AS
SELECT DISTINCT run_id, key,
       CASE WHEN key LIKE 'system/%' THEN 'system'
            WHEN key LIKE 'perf/%' THEN 'perf'
            ELSE 'core' END AS category
FROM metrics;

-- Hyperparameters and tags with the JSON scalar unwrapped to text.
CREATE OR REPLACE VIEW evidence_run_params AS
SELECT run_id, key, value ->> '$' AS value FROM params;

CREATE OR REPLACE VIEW evidence_run_tags AS
SELECT run_id, key, value ->> '$' AS value FROM tags;
"""
