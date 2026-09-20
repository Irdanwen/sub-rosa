-- An errand: one of your devices asking another of your devices to fetch a
-- link. The only synchronised object that is an instruction rather than a
-- record, which is why it is addressed to one device, single use, bounded in
-- time, and ignored unless that machine's owner switched errands on (ADR-0054).
CREATE TABLE IF NOT EXISTS account_errands (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL, url TEXT NOT NULL, folder_id TEXT,
 requested_by TEXT NOT NULL DEFAULT '', requested_at TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'requested', note_id TEXT, message TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_errands_state ON account_errands(state, device_id);

-- Proof that this device already began this errand, kept here and never
-- synchronised. A synchronised row can legitimately come back as requested
-- after a conflict, a restore, or an old revision arriving late, and paid work
-- must not run a second time because of it.
CREATE TABLE IF NOT EXISTS account_errand_runs (
 errand_id TEXT PRIMARY KEY, ingest_id TEXT, started_at TEXT NOT NULL
);
