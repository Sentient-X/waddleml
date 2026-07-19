-- The waddle platform's transactional metadata. Metric/log history lives in
-- ClickHouse, never here. Every table is keyed by org_id (the central auth
-- service's org uuid) — the company-isolation unit. Run ids are the SDK's
-- 32-hex-char ids and are unique per org, not globally: a foreign org can
-- neither collide with nor probe another org's run ids.

CREATE TABLE projects (
    id         uuid PRIMARY KEY,
    org_id     uuid NOT NULL,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name)
);

CREATE TABLE runs (
    org_id       uuid NOT NULL,
    id           text NOT NULL CHECK (id ~ '^[a-f0-9]{32}$'),
    project_id   uuid NOT NULL REFERENCES projects(id),
    name         text NOT NULL,
    display_name text,
    state        text NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'aborted')),
    group_name   text,
    job_type     text,
    config       jsonb NOT NULL DEFAULT '{}',
    summary      jsonb NOT NULL DEFAULT '{}',
    commit_sha   text,
    created_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz NOT NULL,
    finished_at  timestamptz,
    heartbeat_at timestamptz,
    PRIMARY KEY (org_id, id)
);

CREATE INDEX runs_org_project_created ON runs (org_id, project_id, created_at DESC);

CREATE TABLE run_workers (
    org_id     uuid NOT NULL,
    run_id     text NOT NULL,
    rank       integer NOT NULL,
    local_rank integer NOT NULL,
    world_size integer NOT NULL,
    node_id    text NOT NULL,
    attempt    integer NOT NULL,
    writer_id  uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, run_id, rank, attempt),
    FOREIGN KEY (org_id, run_id) REFERENCES runs (org_id, id)
);

-- The batch idempotency ledger: at-least-once delivery becomes exactly-once
-- logical ingestion. payload_sha256 is the digest of the decompressed request
-- body as received — a replayed batch_id must be byte-identical.
CREATE TABLE run_batches (
    org_id         uuid NOT NULL,
    batch_id       uuid NOT NULL,
    run_id         text NOT NULL,
    writer_id      uuid NOT NULL,
    payload_sha256 text NOT NULL,
    sequence_start bigint NOT NULL,
    sequence_end   bigint NOT NULL,
    received_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, batch_id),
    FOREIGN KEY (org_id, run_id) REFERENCES runs (org_id, id)
);

CREATE INDEX run_batches_writer ON run_batches (org_id, run_id, writer_id, sequence_end DESC);

-- Per-org overrides of the settings-default ingest guardrails; absent row =
-- defaults apply.
CREATE TABLE org_limits (
    org_id               uuid PRIMARY KEY,
    ingest_rpm           integer,
    max_points_per_batch integer
);
