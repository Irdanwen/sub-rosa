-- Versions of a workflow the person kept (the canvas, Save a version)
-- One row per version: the whole stored graph as it was, under a name the
-- person can change. A run already keeps the graph it ran, so these are the
-- deliberate ones. Local to the device, like the step cache.
CREATE TABLE IF NOT EXISTS studio_workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  label TEXT NOT NULL,
  definition TEXT NOT NULL,
  format_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_studio_workflow_versions_workflow ON studio_workflow_versions(workflow_id, created_at);
