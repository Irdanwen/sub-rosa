-- Long-form summaries (ADR-0027): the map-reduce reading of a long transcript,
-- kept apart from the note's own generated content.
--
-- It is a separate row rather than a generation block because the two are not
-- the same kind of thing. A generation block is one incremental instalment of
-- meeting notes, keyed by the recording session that produced it and composed
-- into the note the user edits. A long-form summary is a whole-transcript
-- reading, regenerable in place, and re-running it must never touch a word the
-- user wrote. One note may hold both.
--
-- The row is also the unit of recovery. A summary of a two-hour talk is a
-- dozen model calls over several minutes, which on iOS is several lifetimes of
-- a foreground session, so the row is written before the work starts and the
-- sweep re-drives whatever it finds unfinished. See ADR-0018.
--
-- parts_json is what makes that resume cheap rather than merely correct. Each
-- finished map pass is appended to it, so a run interrupted at part eleven of
-- twelve resumes at part twelve instead of re-buying the eleven that already
-- landed. The parts are only reused when chunk_count still matches, since a
-- re-transcribed note chunks differently and the indices would no longer line
-- up.
--
-- status is pending, running, ready or failed.
--
-- NOTE: run_migrations naively splits this file on the semicolon character, so
-- no comment here may contain one.
CREATE TABLE IF NOT EXISTS note_summaries (
  note_id TEXT PRIMARY KEY NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  short_summary TEXT,
  detailed_summary TEXT,
  transcript_chars INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  chunks_done INTEGER NOT NULL DEFAULT 0,
  parts_json TEXT,
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_summaries_status
ON note_summaries (status, updated_at DESC);
