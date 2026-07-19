-- Content-addressed, versioned artifacts (checkpoints, datasets, media) and
-- the run lineage graph. Blob keys are org-scoped on R2
-- (orgs/{org}/blobs/sha256/{2ch}/{digest}) — dedup deliberately stops at the
-- org boundary so blob existence can never leak across companies.

CREATE TABLE artifact_collections (
    id         uuid PRIMARY KEY,
    org_id     uuid NOT NULL,
    project_id uuid NOT NULL REFERENCES projects(id),
    name       text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('model', 'dataset', 'media', 'file')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, project_id, name)
);

CREATE TABLE artifact_versions (
    id                uuid PRIMARY KEY,
    org_id            uuid NOT NULL,
    collection_id     uuid NOT NULL REFERENCES artifact_collections(id),
    version_number    integer NOT NULL,
    digest            text NOT NULL,
    metadata          jsonb NOT NULL DEFAULT '{}',
    manifest          jsonb NOT NULL,
    created_by_run_id text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (collection_id, version_number),
    UNIQUE (collection_id, digest)
);

CREATE TABLE artifact_files (
    artifact_version_id uuid NOT NULL REFERENCES artifact_versions(id),
    logical_path        text NOT NULL,
    blob_sha256         text NOT NULL,
    r2_key              text NOT NULL,
    size_bytes          bigint NOT NULL,
    media_type          text,
    PRIMARY KEY (artifact_version_id, logical_path)
);

CREATE TABLE artifact_aliases (
    collection_id uuid NOT NULL REFERENCES artifact_collections(id),
    alias         text NOT NULL,
    version_id    uuid NOT NULL REFERENCES artifact_versions(id),
    PRIMARY KEY (collection_id, alias)
);

CREATE TABLE artifact_lineage (
    org_id              uuid NOT NULL,
    run_id              text NOT NULL,
    artifact_version_id uuid NOT NULL REFERENCES artifact_versions(id),
    relation            text NOT NULL CHECK (relation IN ('input', 'output')),
    PRIMARY KEY (org_id, run_id, artifact_version_id, relation),
    FOREIGN KEY (org_id, run_id) REFERENCES runs (org_id, id)
);

-- Declared-then-uploaded staging state; expired sessions are swept by the
-- compaction worker (their partial R2 objects aborted).
CREATE TABLE upload_sessions (
    id         uuid PRIMARY KEY,
    org_id     uuid NOT NULL,
    state      text NOT NULL CHECK (state IN ('open', 'committed', 'expired')),
    files      jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

-- The compaction worker's Parquet export watermarks (org × month partitions).
CREATE TABLE parquet_exports (
    org_id      uuid NOT NULL,
    dataset     text NOT NULL CHECK (dataset IN ('metrics', 'logs', 'runs', 'params')),
    partition   text NOT NULL,
    max_ts      timestamptz,
    exported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, dataset, partition)
);
