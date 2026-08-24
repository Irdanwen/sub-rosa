-- The shot list: a note broken into the shots a film is made of.
--
-- A separate row rather than something on the note, for the same reason a
-- long-form summary is (see 015): it is derived, it is regenerable in place,
-- and re-running it must never touch a word the user wrote. The note is the
-- script. This is a reading of it.
--
-- It is also the unit of recovery. Breaking a long script down is several
-- model calls over minutes, which on iOS is several lifetimes of a foreground
-- session, so the row is written before the work starts and the sweep
-- re-drives whatever it finds unfinished. See ADR-0018.
--
-- parts_json is what makes resuming cheap rather than merely correct. Each
-- finished map pass is appended to it, so a run interrupted at part four of
-- five resumes at part five instead of re-buying the four that landed. Parts
-- are only reused when chunk_count still matches, since an edited script
-- chunks differently and the indices would no longer line up.
--
-- shots_json holds the finished list. What it deliberately does NOT hold is a
-- model id, a duration or an aspect ratio: the model returns a motion class
-- and who is in the shot, and the app resolves those into a render. Asking a
-- language model to pick a video model is asking it to know a catalogue it has
-- never seen.
--
-- status is pending, running, ready or failed.
--
-- NOTE: run_migrations naively splits this file on the semicolon character, so
-- no comment here may contain one.
CREATE TABLE IF NOT EXISTS shot_lists (
  note_id TEXT PRIMARY KEY NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  shots_json TEXT,
  parts_json TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  script_chars INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
