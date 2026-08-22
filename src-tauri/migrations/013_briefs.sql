-- The brief: one row per meeting, scheduled ahead of time and settled once.
-- A row, not a timer (ADR-0018) — iOS suspends the process, and a promise
-- made in JavaScript for "ten minutes before the 10:00" is one the platform
-- will not keep. The sweep schedules and delivers, and this table is the truth.
-- Status is pending until the moment arrives, then delivered or skipped.
-- Skipped is a first-class outcome: silence is a feature here, not a failure.
-- NOTE no semicolons in these comments, run_migrations splits on them
CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  calendar_event_id TEXT NOT NULL,
  event_title TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  body TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One brief per meeting, ever, across relaunches and reschedules.
CREATE UNIQUE INDEX IF NOT EXISTS idx_briefs_event ON briefs(calendar_event_id);

CREATE INDEX IF NOT EXISTS idx_briefs_due ON briefs(status, scheduled_for)
