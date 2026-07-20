-- Controller-authored research conclusions are terminal facts, not UI guesses.
ALTER TABLE runs ADD COLUMN research_outcome jsonb;

-- Research pages group by the typed session identity stored in the reserved
-- research record. Keep this read org/project scoped and replica-friendly.
CREATE INDEX runs_research_sessions
    ON runs (
        org_id,
        project_id,
        (COALESCE(config -> '_waddle_research' ->> 'session_name', '')),
        created_at DESC
    )
    WHERE job_type = 'autoresearch';
