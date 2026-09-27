-- What the app changed on its own after a reflex decided (ADR-0065). Local
-- to this device and never synchronised: the change itself travels as an
-- ordinary revision of the row it touched, and this is only the record a
-- person reads and undoes from. before_json and after_json hold what the
-- undo compares and restores.
CREATE TABLE IF NOT EXISTS autonomous_changes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  probability REAL NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS autonomous_changes_created ON autonomous_changes(created_at DESC);
