-- Durable rows for work that must survive the app being suspended or killed.
--
-- `media_jobs` holds Studio generations that were already queued (and paid
-- for) upstream. The frontend used to poll them from JavaScript, which stops
-- dead the moment iOS freezes the webview. Rust now owns the poll, the
-- download and the notification, and this table is what lets it pick a job
-- back up after a cold launch.
--
-- `status` is queued, processing, completed or failed. A completed row keeps
-- the artifact it wrote to the gallery until the frontend acknowledges it,
-- so a generation that lands while the app is closed still reaches the UI.
--
-- `pending_dictations` is the same idea for mobile dictation, whose audio is
-- already on disk when the transcription round-trip starts.
--
-- NOTE: run_migrations naively splits this file on the semicolon character,
-- so no comment here may contain one.
CREATE TABLE IF NOT EXISTS media_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  extension TEXT NOT NULL,
  retrieve_path TEXT NOT NULL,
  retrieve_body TEXT NOT NULL,
  url_fields TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  artifact_path TEXT,
  artifact_file_name TEXT,
  artifact_bytes INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS pending_dictations (
  id TEXT PRIMARY KEY,
  audio_path TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT 'standard',
  language TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
