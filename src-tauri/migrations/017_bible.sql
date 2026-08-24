-- The bible: the persistent identities of a production.
--
-- A character, a location, a prop, a look. Studio surfaces have always been
-- able to attach reference images to a single render, and nothing made those
-- references survive the render, so the same character was re-uploaded, by
-- hand, every session, and drifted a little each time. These rows are the
-- thing that persists.
--
-- Two decisions are worth stating.
--
-- A reference is a POINTER at a gallery artifact, never bytes. The gallery is
-- already the exchange format of the Studio (ADR-0020) and it is already
-- reconciled against the disk. Storing the image here would be a second copy
-- to keep in step with the first, and a second thing to delete.
--
-- Entries carry no run, no project and no owner. A bible belongs to the
-- install, the way the gallery does. A production is a workflow run, and a run
-- is over when it is over, whereas a character outlives every film it is in.
--
-- kind is character, location, prop or look.
-- role is portrait, profile, wide, medium, detail or voice.
--
-- NOTE: run_migrations naively splits this file on the semicolon character, so
-- no comment here may contain one.
CREATE TABLE IF NOT EXISTS bible_entries (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  traits TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bible_entries_kind ON bible_entries(kind, lower(name));

-- artifact_id is the gallery artifact's id, which is its file name. It is not
-- a foreign key because the gallery index lives in the webview and its entries
-- come and go legitimately. A reference whose artifact has gone is reported,
-- not repaired and not deleted behind the user's back.
--
-- ordinal fixes the order references are offered to a model in. That order is
-- load bearing for the reference-to-video families, where the first image is
-- the identity anchor.
CREATE TABLE IF NOT EXISTS bible_refs (
  id TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL REFERENCES bible_entries(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  ordinal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bible_refs_entry ON bible_refs(entry_id, ordinal)
