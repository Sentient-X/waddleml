-- The reproduce-this-run snapshot the SDK captures once at init (host, python,
-- command, git state). Typed at the wire boundary (RunEnvironment); stored
-- whole so absent facts stay absent.
ALTER TABLE runs ADD COLUMN environment jsonb NOT NULL DEFAULT '{}';
