-- A thumbs up or down on a chat reply, with an optional reason (ADR-0082).
-- Kept on this device only. No sync trigger is installed on it and nothing
-- reads it to send it anywhere. It travels only inside an archive the person
-- exports themselves.
-- conversation_id is the phone chat's task id or the desktop's stored Hermes
-- session id, and message_id is that conversation's message id.
CREATE TABLE IF NOT EXISTS reply_ratings (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  reason TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);
