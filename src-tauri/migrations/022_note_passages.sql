-- Passages of notes and transcripts, with their embeddings (ADR-0046).
-- A passage is a few hundred characters of a note body or a window of
-- transcript turns. content_hash is the hash of the source the passages
-- were cut from, so a note that did not change is not re-cut.
-- The embedding is little-endian f32 (BGE-M3, 1024 dims) or NULL until the
-- backfill reaches it. Comments here carry no semicolon on purpose.
CREATE TABLE IF NOT EXISTS note_passages (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_passages_note ON note_passages(note_id);
CREATE INDEX IF NOT EXISTS note_passages_pending ON note_passages(updated_at) WHERE embedding IS NULL;
