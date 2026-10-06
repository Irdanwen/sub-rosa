-- The Studio's workflow library, which lived in the webview's local storage
-- (thirty at most, lost with the storage, no version). A row holds one
-- workflow's graph as JSON with the version of its shape, where it came from
-- (drawn here, or imported from a file), and the gallery file its card shows.
CREATE TABLE IF NOT EXISTS studio_workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL,
  format_version INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'mine',
  cover_artifact_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_studio_workflows_updated ON studio_workflows(updated_at DESC);
