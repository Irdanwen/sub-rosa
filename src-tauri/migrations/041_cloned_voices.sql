-- Cloned voices (ADR-0077). A voice is the sample kept on this device, and
-- the provider handle is only a cache of an upload of it, with its expiry.
-- Local only: not in the account sync tables, a voice is biometric.
CREATE TABLE IF NOT EXISTS cloned_voices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  sample_file TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  handle TEXT,
  handle_expires_at TEXT,
  created_at TEXT NOT NULL
);
