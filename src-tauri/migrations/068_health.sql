-- Health (ADR-0099): one summary per measure and per day, read from the
-- phone's own health store (HealthKit on the iPhone, Health Connect on
-- Android). Read only, never written back. The desktop has no health store
-- and holds only what a phone sent with the person's consent.
-- metric is steps, sleep, heart_rate, resting_heart_rate, workouts or weight.
-- day is the local calendar day (YYYY-MM-DD), the night's sleep counted on
-- the morning it ended. value is a step count, minutes asleep, an average
-- in beats per minute, minutes of exercise or kilograms, by metric. low and
-- high are the day's range where the measure has one, samples how many
-- readings or workouts made the day. id is a name-based UUID of metric and
-- day, so a day read twice is one row and travels as one object.
CREATE TABLE IF NOT EXISTS health_days (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL CHECK (metric IN ('steps', 'sleep', 'heart_rate', 'resting_heart_rate', 'workouts', 'weight')),
  day TEXT NOT NULL,
  value REAL NOT NULL,
  low REAL,
  high REAL,
  samples INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (metric, day)
);

CREATE INDEX IF NOT EXISTS idx_health_days_day ON health_days(day);

-- This device's choices, never synchronised: which measures the person
-- picked (enabled) and which of those they agreed to send with their account
-- (sync). A measure nobody picked is never read, and a picked one stays on
-- the device until its own sync is switched on.
CREATE TABLE IF NOT EXISTS health_metrics (
  metric TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  sync INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
