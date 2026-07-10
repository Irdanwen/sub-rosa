-- User memories: durable facts about the user, extracted from agent chats
-- (or added manually) and injected into future conversations so the user
-- never has to repeat themselves. Shared by the desktop (Hermes) and mobile
-- (agent-lite) chat pipelines.
--
-- `importance` follows a 1 (essential) to 10 (trivial) scale — lower is more
-- important, and the extractor discards anything above 8 before insertion.
-- `embedding` holds an optional little-endian f32 vector for semantic recall.
-- It stays NULL until the sidecar embedding backfill runs.
--
-- NOTE: run_migrations naively splits this file on the semicolon character,
-- so no comment here may contain one.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  importance INTEGER NOT NULL DEFAULT 5,
  disabled INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_rank ON memories(disabled, importance, created_at DESC);
