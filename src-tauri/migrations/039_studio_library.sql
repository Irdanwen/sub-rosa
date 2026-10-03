-- How the Studio gallery is organised, kept apart from what produced each file
-- so that it can travel between devices with the account (ADR-0073).
-- A collection is a named group of gallery files, the "folders" of the gallery.
CREATE TABLE IF NOT EXISTS studio_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- What a person said about one gallery file. The id is the UUID stem of the
-- gallery file name, the same on every device the file reaches.
CREATE TABLE IF NOT EXISTS studio_marks (
  id TEXT PRIMARY KEY,
  collection_id TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_studio_marks_collection ON studio_marks(collection_id);
