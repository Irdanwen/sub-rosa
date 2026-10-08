-- Study mode (ADR-0089): the cards a person added to review from a chat,
-- scheduled by spaced repetition. Kept on this device, carried by the archive.
-- source_key is a digest of the front and back, so adding a deck twice keeps
-- one card each. ease, interval_days and repetitions are the SM-2 state.
CREATE TABLE IF NOT EXISTS study_cards (
  id TEXT PRIMARY KEY,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  deck TEXT,
  source_key TEXT NOT NULL UNIQUE,
  chat_id TEXT,
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 0,
  repetitions INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  last_reviewed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_study_cards_due ON study_cards(due_at);

-- The chats in study mode. A row means on, so a chat nobody switched keeps
-- the ordinary assistant.
CREATE TABLE IF NOT EXISTS study_chats (
  chat_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL
);
