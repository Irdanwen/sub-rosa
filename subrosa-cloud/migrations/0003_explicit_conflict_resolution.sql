ALTER TABLE revisions ADD COLUMN resolved_revisions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(resolved_revisions)='array');
