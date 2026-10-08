-- Deep research (ADR-0089): a question read across the web and the person's
-- own notes, written up as a note with numbered sources the app resolved.
-- Every step is a row, so a run outlives the process that started it and the
-- background sweep re-drives it (ADR-0018). Kept on this device.
-- status is clarifying, planned, running, done, stopped or failed.
-- plan holds the sections and searches the person approved, as JSON.
CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  depth TEXT NOT NULL CHECK (depth IN ('quick', 'standard', 'deep')),
  status TEXT NOT NULL,
  use_notes INTEGER NOT NULL DEFAULT 1,
  project_id TEXT,
  chat_id TEXT,
  clarify_questions TEXT NOT NULL DEFAULT '[]',
  clarify_answers TEXT NOT NULL DEFAULT '[]',
  plan TEXT,
  model TEXT NOT NULL,
  phase TEXT,
  report_note_id TEXT,
  cited_sources INTEGER NOT NULL DEFAULT 0,
  invented_citations INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  prompt_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_runs_status ON research_runs(status);

-- One search of the approved plan. pending until its results are filed.
CREATE TABLE IF NOT EXISTS research_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  section TEXT NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_research_steps_run ON research_steps(run_id, position);

-- A source a search found. source_key is the address for a page and the
-- note or project for the person's own material, so a search run twice
-- files a source once. kind connector is reserved for connected apps.
-- notes are what the model kept from it, read once.
CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'note', 'project_file', 'connector')),
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  note_id TEXT,
  excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  UNIQUE (run_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(run_id, position);
