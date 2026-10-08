-- A connector a browser tab cannot reach, run for it by one of the person's
-- own apps (ADR-0107). Three travelling tables and one ledger kept here.

-- What one device offers to run for the account's other devices: a
-- connector signed in here, and the tools it listed. Written by that device
-- only while its owner switched relaying on, removed when it no longer can.
-- The id is derived from the device and the connector, so it is one object.
CREATE TABLE IF NOT EXISTS connector_relays (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  connector_id TEXT NOT NULL,
  connector_name TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_relays_device ON connector_relays(device_id);

-- One connector call another device asked this device to make: an errand
-- (ADR-0054), addressed to one device, single use and short lived. approved
-- is 1 when the person approved it where they asked. state is requested,
-- ask (this device's rule wants the person's yes first), done, failed or
-- declined. result is the bounded result the call returned.
CREATE TABLE IF NOT EXISTS connector_errands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '{}',
  approved INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested',
  result TEXT,
  message TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_errands_state ON connector_errands(state, device_id);

-- Proof that this device already began a connector errand, never
-- synchronised, written before the call leaves: a row that comes back as
-- requested after a conflict or a restore must not act twice.
CREATE TABLE IF NOT EXISTS connector_errand_runs (
  errand_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL
);

-- A daily brief card as the device that composed it wrote it, agenda line
-- included, so a device that cannot read a calendar (a browser) shows it.
-- One object per device and day. The local daily_briefs row stays the
-- ledger of what this device announced.
CREATE TABLE IF NOT EXISTS daily_brief_cards (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  card TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS daily_brief_cards_day ON daily_brief_cards(day);
