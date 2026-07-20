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
    lineage JSON,
    group_name VARCHAR,
    job_type VARCHAR,
    research_outcome JSON
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

CREATE TABLE IF NOT EXISTS log_lines (
    run_id VARCHAR NOT NULL,
    ts DOUBLE NOT NULL,
    level VARCHAR NOT NULL DEFAULT 'info',
    source VARCHAR NOT NULL DEFAULT '',
    message VARCHAR NOT NULL,
    rank INTEGER NOT NULL DEFAULT 0,
    node_id VARCHAR NOT NULL DEFAULT 'localhost',
    attempt INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_log_lines_run ON log_lines(run_id);

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
ALTER TABLE runs ADD COLUMN IF NOT EXISTS group_name VARCHAR;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS job_type VARCHAR;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS research_outcome JSON;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS rank INTEGER DEFAULT 0;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS node_id VARCHAR DEFAULT 'localhost';
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS attempt INTEGER DEFAULT 0;


-- Views prefixed evidence_ are the analysis read contract over a spool DB:
-- agents (the glued `waddle-dashboard` skill above all) query them instead of
-- re-deriving joins, decimation, and JSON extraction from the raw tables.
-- The name is historical — they were born as the read contract for the
-- Evidence.dev dashboard (deleted 2026-07-19, in git history). Renaming them
-- would break every existing spool snapshot, so they keep the prefix.
-- (NB: _db.py naively splits this DDL on the semicolon character — never use
-- one inside a comment.)

-- Long metric stream joined to its run: one row per (run, key, step).
CREATE OR REPLACE VIEW evidence_run_metrics AS
SELECT r.project, r.id AS run_id, r.name AS run_name, r.status,
       r.started_at, r.ended_at, r.config, r.lineage,
       m.key, m.step, m.ts, m.value, m.rank, m.node_id, m.attempt
FROM runs r JOIN metrics m ON r.id = m.run_id;

-- Chart-ready training metrics: superseded pre-resume rows dropped, decimated to
-- <=600 min/max-preserving buckets per (run, key), with a trailing moving-average
-- smooth. Dashboards chart THIS, never the raw stream — a 100k-step run stays a
-- few hundred points per chart. system/* is excluded (its step is a sample
-- counter, not the training step — see evidence_system_metrics).
CREATE OR REPLACE VIEW evidence_run_metrics_ds AS
WITH successor AS (
    SELECT run_id, key, attempt, min(step) AS resume_step
    FROM metrics GROUP BY run_id, key, attempt
),
dedup AS (
    SELECT m.run_id, m.key, m.attempt, m.step, m.ts, m.value
    FROM metrics m
    LEFT JOIN successor n
      ON n.run_id = m.run_id AND n.key = m.key AND n.attempt = m.attempt + 1
    WHERE m.key NOT LIKE 'system/%'
      AND (n.resume_step IS NULL OR m.step < n.resume_step)
),
width AS (
    SELECT run_id, key,
           greatest(1, ((max(step) - min(step)) / 600)::BIGINT) AS w
    FROM dedup GROUP BY run_id, key
),
bucketed AS (
    SELECT d.run_id, d.key,
           (d.step // s.w) * s.w AS step,
           avg(d.value) AS value,
           min(d.value) AS value_min,
           max(d.value) AS value_max,
           max(d.ts) AS ts
    FROM dedup d JOIN width s USING (run_id, key)
    GROUP BY d.run_id, d.key, (d.step // s.w) * s.w
)
SELECT r.project, r.name AS run_name, b.*,
       avg(b.value) OVER (PARTITION BY b.run_id, b.key ORDER BY b.step
                          ROWS BETWEEN 20 PRECEDING AND CURRENT ROW) AS value_smooth
FROM bucketed b JOIN runs r ON r.id = b.run_id;

-- system/* metrics on the wall-clock axis (their step column is the sampler's own
-- counter). Time-bucketed to <=400 points per (run, key).
CREATE OR REPLACE VIEW evidence_system_metrics AS
WITH sysm AS (
    SELECT m.run_id, r.name AS run_name, r.project, m.key, m.ts, m.value
    FROM metrics m JOIN runs r ON r.id = m.run_id
    WHERE m.key LIKE 'system/%'
),
width AS (
    SELECT run_id, key, greatest(15.0, (max(ts) - min(ts)) / 400) AS w
    FROM sysm GROUP BY run_id, key
)
SELECT s.project, s.run_name, s.run_id, s.key,
       to_timestamp(floor(s.ts / p.w) * p.w) AS t,
       avg(s.value) AS value,
       min(s.value) AS value_min,
       max(s.value) AS value_max
FROM sysm s JOIN width p USING (run_id, key)
GROUP BY ALL;

-- One row per (run, attempt): the resume seams. start_step of attempt N>0 is
-- where run N resumed — dashboards draw it as a reference line.
CREATE OR REPLACE VIEW evidence_attempts AS
SELECT m.run_id, m.attempt,
       min(m.step) AS start_step, max(m.step) AS end_step,
       min(m.ts) AS started_ts, max(m.ts) AS ended_ts,
       'resume #' || m.attempt AS label
FROM metrics m WHERE m.key NOT LIKE 'system/%'
GROUP BY m.run_id, m.attempt;

-- Live-monitoring vitals per run: progress toward the 'steps' param, trailing
-- 3-minute throughput, ETA, and staleness. live_status upgrades 'running' to
-- 'stalled' when no metric landed for >120s — a crashed loop never flips its own
-- status row, so staleness is the only honest liveness signal.
CREATE OR REPLACE VIEW evidence_run_progress AS
WITH tgt AS (
    SELECT run_id, try_cast(value ->> '$' AS BIGINT) AS steps_target
    FROM params WHERE key = 'steps'
),
core AS (
    SELECT run_id, max(step) AS last_step, max(ts) AS last_ts
    FROM metrics WHERE key NOT LIKE 'system/%' GROUP BY run_id
),
recent AS (
    SELECT m.run_id,
           (max(m.step) - min(m.step)) / greatest(1e-9, max(m.ts) - min(m.ts))
               AS steps_per_second
    FROM metrics m JOIN core c USING (run_id)
    WHERE m.key NOT LIKE 'system/%' AND m.ts >= c.last_ts - 180
    GROUP BY m.run_id
)
SELECT r.id AS run_id, r.name AS run_name, r.project, r.status,
       t.steps_target, c.last_step, c.last_ts,
       epoch(now()) - c.last_ts AS staleness_seconds,
       CASE WHEN r.status = 'running' AND epoch(now()) - c.last_ts > 120
            THEN 'stalled' ELSE r.status END AS live_status,
       re.steps_per_second,
       CASE WHEN t.steps_target > 0
            THEN least(1.0, (c.last_step + 1.0) / t.steps_target) END AS progress,
       CASE WHEN r.status = 'running' AND re.steps_per_second > 0 AND t.steps_target > 0
            THEN (t.steps_target - 1 - c.last_step) / re.steps_per_second
            END AS eta_seconds
FROM runs r
LEFT JOIN tgt t ON t.run_id = r.id
LEFT JOIN core c ON c.run_id = r.id
LEFT JOIN recent re ON re.run_id = r.id;

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
       r.group_name, r.job_type,
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
