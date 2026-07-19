-- Reports become id-addressed resources: a stable uuid is the URL/API identity,
-- the name is a renameable per-org slug, and every save appends an immutable
-- row to report_versions (the report's history; restore = save an old body).

ALTER TABLE reports ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE reports DROP CONSTRAINT reports_pkey;
ALTER TABLE reports ADD PRIMARY KEY (id);
ALTER TABLE reports ADD CONSTRAINT reports_org_name_unique UNIQUE (org_id, name);
ALTER TABLE reports ADD COLUMN version integer NOT NULL DEFAULT 1;

CREATE TABLE report_versions (
    report_id  uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    org_id     uuid NOT NULL,
    version    integer NOT NULL,
    name       text NOT NULL,
    body       text NOT NULL,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (report_id, version)
);

INSERT INTO report_versions (report_id, org_id, version, name, body, updated_by, created_at)
SELECT id, org_id, 1, name, body, updated_by, updated_at FROM reports;
