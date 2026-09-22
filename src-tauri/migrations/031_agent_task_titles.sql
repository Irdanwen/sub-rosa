-- Which chats still wait for a title from the model, and which were named by the person
-- Local only, never synchronized or archived: a column on agent_tasks would make
-- every older app version reject every revision a newer one sends
CREATE TABLE IF NOT EXISTS agent_task_titles (
 task_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'pending',
 expected_title TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_task_titles_pending ON agent_task_titles(state, created_at);
