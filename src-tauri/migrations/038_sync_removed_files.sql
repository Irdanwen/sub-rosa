-- Files a remote deletion leaves behind on this device
-- The sync apply path runs on a database connection that knows nothing of the
-- app's directories, so it records what became orphaned and the file lane,
-- which resolves those directories afresh on every pass, removes it
CREATE TABLE IF NOT EXISTS account_sync_removed_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
