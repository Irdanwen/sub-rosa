-- Fetching what a link points at (ADR-0028).
--
-- Everything BEFORE transcription lives here: resolve the link, fetch the
-- bytes, hand the file to the import pipeline. Once the file is on disk the
-- note pipeline owns the rest, which is why nothing was added to
-- ProcessingStatus for this -- an ingest that has produced its note is done,
-- and the note carries its own state from there.
--
-- A row, not a task, because a two-hour talk on a hotel connection outlives a
-- foreground session many times over. See ADR-0018.
--
-- kind is direct, feed or platform. status is pending, fetching, done or
-- failed.
--
-- NOTE: run_migrations naively splits this file on the semicolon character, so
-- no comment here may contain one.
CREATE TABLE IF NOT EXISTS ingests (
  id TEXT PRIMARY KEY NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT,
  media_url TEXT,
  note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  folder_id TEXT,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingests_status
ON ingests (status, created_at DESC);
