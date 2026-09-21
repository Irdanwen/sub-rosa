CREATE TABLE IF NOT EXISTS assistant_conversations (
    task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
    assistant_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_conversations_assistant ON assistant_conversations(assistant_id);
