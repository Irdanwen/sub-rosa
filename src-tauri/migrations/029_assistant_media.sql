-- Paid proposals are device-local capabilities, never synchronised execution
CREATE TABLE IF NOT EXISTS assistant_media (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 model TEXT NOT NULL,
 prompt TEXT NOT NULL,
 parameters TEXT NOT NULL,
 backend TEXT NOT NULL,
 cost_credits REAL,
 status TEXT NOT NULL DEFAULT 'proposed',
 queue_id TEXT,
 artifact_file_name TEXT,
 error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_media_task ON assistant_media(task_id);
