-- Assignments (ADR-0091): a standing goal the assistant works on again and
-- again, on a cadence, on the one device the row names, and only while an app
-- is open there. A scheduled task is the same row with kind task, whose
-- results need no review. Synchronised, so any of your devices can create,
-- pause and review one, and run only by device_id, so nothing races.
-- device_id is empty for a library with no account, which means this device.
-- origin_device_id is the device that wrote it, and a machine runs one that
-- another device wrote only when its owner accepts work from other devices.
-- cadence is hourly, daily, weekdays, weekly or every, at_minute counts from
-- local midnight, weekday runs from 0 for Sunday, every_hours is the gap.
-- active_since is when it was created or last resumed, so a slot that passed
-- while it was paused is never run late.
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'assignment',
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  cadence TEXT NOT NULL,
  at_minute INTEGER NOT NULL DEFAULT 540,
  weekday INTEGER NOT NULL DEFAULT 1,
  every_hours INTEGER NOT NULL DEFAULT 4,
  autonomy TEXT NOT NULL DEFAULT 'ask',
  tools TEXT NOT NULL DEFAULT '["web","notes"]',
  device_id TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT '',
  origin_device_id TEXT NOT NULL DEFAULT '',
  paused INTEGER NOT NULL DEFAULT 0,
  active_since TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One run of an assignment, and its place in the results inbox. slot is the
-- due time it answers, or now, errand or approved followed by what asked for
-- it. The id is derived from the assignment and the slot, so two devices that
-- both ran one slot made one object. handle is the chat (phone) or the Hermes
-- job (desktop) the run rides on, read only by the device that ran it.
-- state is running, needs_review, approved, rejected, done or failed.
-- feedback is what the person said when they reviewed it, and the next run
-- reads it.
CREATE TABLE IF NOT EXISTS assignment_runs (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  device_id TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT '',
  handle TEXT,
  state TEXT NOT NULL DEFAULT 'running',
  result TEXT,
  error TEXT,
  feedback TEXT,
  reviewed_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assignment_runs_assignment ON assignment_runs(assignment_id, started_at);
CREATE INDEX IF NOT EXISTS idx_assignment_runs_state ON assignment_runs(state);

-- Proof that this device already started this slot, kept here and never
-- synchronised, like account_errand_runs. A synchronised run can come back
-- in an older state after a conflict or a restore, and paid work must not
-- run a second time because of it.
CREATE TABLE IF NOT EXISTS assignment_slot_runs (
  assignment_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  run_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY (assignment_id, slot)
);

-- The daily brief (ADR-0091, an addendum to the moments): one card per local
-- day, written once at the time the person chose and settled once. status is
-- delivered, or silent when there was nothing to say.
CREATE TABLE IF NOT EXISTS daily_briefs (
  day TEXT PRIMARY KEY,
  card TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The topics the person asked the daily brief to follow. One web search each,
-- once a day, and only while the brief is on. Kept on this device.
CREATE TABLE IF NOT EXISTS followed_topics (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  created_at TEXT NOT NULL
)
