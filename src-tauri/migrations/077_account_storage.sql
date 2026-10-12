-- Keeping the account inside its quota (ADR-0110)

-- A chunk this device may give back once nothing it knows still names it.
-- A row is a candidate: it is checked again just before it goes.
-- not_before is unix seconds.
CREATE TABLE IF NOT EXISTS account_blob_releases (
  blob_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  not_before INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_blob_releases_due ON account_blob_releases(not_before);

-- What this device knows about the account's room, and what it holds back.
-- Times are unix seconds.
CREATE TABLE IF NOT EXISTS account_storage_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  used_bytes INTEGER,
  quota_bytes INTEGER,
  file_bytes INTEGER,
  reserve_bytes INTEGER,
  measured_at INTEGER,
  push_held_until INTEGER NOT NULL DEFAULT 0,
  files_held_until INTEGER NOT NULL DEFAULT 0,
  format_v2 INTEGER NOT NULL DEFAULT 0,
  blockers_json TEXT NOT NULL DEFAULT '[]',
  gate_checked_at INTEGER NOT NULL DEFAULT 0,
  last_sweep_at INTEGER NOT NULL DEFAULT 0,
  send_audio INTEGER NOT NULL DEFAULT 1,
  send_studio INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO account_storage_state(id) VALUES (1);

-- File manifests deleted in the journal whose chunks were already put up for release
CREATE TABLE IF NOT EXISTS account_storage_settled (
  object_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL
);

-- A file this device sends in its compact form: a recording that has no
-- manifest yet, or a manifest it replaces. id is the new manifest's id.
-- source_path is local and never leaves the device. held_until is unix seconds.
CREATE TABLE IF NOT EXISTS account_file_compactions (
  id TEXT PRIMARY KEY,
  replaces TEXT UNIQUE,
  artifact_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  format TEXT NOT NULL,
  source_path TEXT,
  derived INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  modified TEXT,
  next_offset INTEGER NOT NULL DEFAULT 0,
  chunks_json TEXT NOT NULL DEFAULT '[]',
  pending_blob_id TEXT,
  pending_ciphertext BLOB,
  pending_bytes INTEGER,
  pending_digest TEXT,
  held_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- A manifest held back because some of its chunks are gone from the service
CREATE TABLE IF NOT EXISTS account_chunk_repairs (
  operation_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  missing_json TEXT NOT NULL
);

-- How an upload seals its chunks: 1 is the JSON text envelope, 2 the binary one
ALTER TABLE account_file_uploads ADD COLUMN envelope INTEGER NOT NULL DEFAULT 1;

-- An upload abandoned before its manifest was written leaves chunks nobody names
CREATE TRIGGER IF NOT EXISTS account_file_uploads_released AFTER DELETE ON account_file_uploads
WHEN old.completed = 0
BEGIN
  INSERT OR IGNORE INTO account_blob_releases(blob_id, reason, not_before)
    SELECT json_extract(j.value, '$.id'), 'abandoned upload', CAST(strftime('%s', 'now') AS INTEGER) + 3600
    FROM json_each(old.chunks_json) j;
  INSERT OR IGNORE INTO account_blob_releases(blob_id, reason, not_before)
    SELECT old.pending_blob_id, 'abandoned upload', CAST(strftime('%s', 'now') AS INTEGER) + 3600
    WHERE old.pending_blob_id IS NOT NULL;
END;

-- A manifest that goes takes any download of it still under way, and its partial file
CREATE TRIGGER IF NOT EXISTS account_file_manifests_gone AFTER DELETE ON account_file_manifests
BEGIN
  DELETE FROM account_file_downloads WHERE manifest_id = old.id AND completed = 0;
  INSERT INTO account_sync_removed_files(lane, path, created_at)
    VALUES ('staging', old.id || '.part', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
END;
