-- Per-org ingest windows. Like every other table here, org_id is the central auth
-- service's org uuid and carries no foreign key: that row lives in sx_authd's
-- database, not this one.
CREATE TABLE ingest_rate_windows (
    org_id uuid NOT NULL,
    window_start timestamptz NOT NULL,
    request_count integer NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (org_id, window_start)
);

CREATE INDEX ingest_rate_windows_expiry_idx
    ON ingest_rate_windows (window_start);
