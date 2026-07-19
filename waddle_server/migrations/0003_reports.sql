-- Reports as code: org-scoped markdown documents (Evidence dialect) rendered
-- over the org's Parquet substrate through the SQL sandbox. The body is the
-- source of truth; title/description are denormalized from its frontmatter at
-- save time for cheap listing.

CREATE TABLE reports (
    org_id      uuid NOT NULL,
    name        text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
    title       text,
    description text,
    body        text NOT NULL,
    updated_by  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, name)
);
