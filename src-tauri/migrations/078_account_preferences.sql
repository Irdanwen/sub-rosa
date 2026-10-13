-- Choices that follow the account to every device (ADR-0111)
-- One row, under a fixed id. audio_retention_days is how many days after
-- transcription a recording is deleted, on every device and in the account.
-- NULL keeps recordings.
CREATE TABLE IF NOT EXISTS account_preferences (
  id TEXT PRIMARY KEY,
  audio_retention_days INTEGER CHECK (audio_retention_days IS NULL OR audio_retention_days BETWEEN 1 AND 365),
  updated_at TEXT NOT NULL
);
