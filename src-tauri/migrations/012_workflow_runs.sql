-- Durable rows for Studio workflow productions (ADR-0021)
--
-- A run freezes its graph at launch (definition) and tracks one row per node
-- so the webview can resume stitching exactly where it stopped after a kill
-- or a suspension. The long renders themselves ride the media_jobs table --
-- Rust keeps polling those with or without a webview -- and a running node
-- points at its job through the pendingJobId field of its output column, so
-- an expensive render is queued exactly once across any number of resumes.
--
-- Run status is running, completed, failed or cancelled. Node status mirrors
-- the engine (pending, running, done, error). A settled run keeps its rows
-- until the user dismisses it, same contract as media_jobs.
--
-- NOTE: run_migrations naively splits this file on the semicolon character,
-- so no comment here may contain one.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  node_costs TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_run_nodes (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  output TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id)
);
