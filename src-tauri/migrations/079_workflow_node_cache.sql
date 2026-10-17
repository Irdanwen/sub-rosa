-- The workflow step cache (ADR-0115)
-- One row per paid step whose result can be reused. key is a hash of exactly
-- what the step was asked (its settings, its model, its inputs as they were),
-- static_key the same hash taken before a run from settings alone, which is
-- what lets the canvas say which steps will be reused and price the rest.
-- output refers to the gallery file the step made, never to its bytes.
CREATE TABLE IF NOT EXISTS workflow_node_cache (
  key TEXT PRIMARY KEY,
  static_key TEXT NOT NULL,
  node_type TEXT NOT NULL,
  output TEXT NOT NULL,
  workflow_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_node_cache_static ON workflow_node_cache(static_key);

CREATE INDEX IF NOT EXISTS idx_workflow_node_cache_used ON workflow_node_cache(used_at);
