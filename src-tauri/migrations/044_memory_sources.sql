-- Which remembered facts a reply was given (ADR-0081).
-- A record is one injection. On the phone its owner is the user message that
-- opened the turn, so the reply under it can say which memories it carried.
-- On the desktop its owner is a stored Hermes session id, bound to the memory
-- block the runtime's SOUL carried when the session was first seen.
-- An empty injection is still a record, which is why records and their
-- memories are two tables. Local only, like the injection itself.
CREATE TABLE IF NOT EXISTS memory_source_records (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  task_id TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_source_records_task ON memory_source_records (task_id);

CREATE TABLE IF NOT EXISTS memory_sources (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, memory_id)
);
