-- A temporary chat (ADR-0083) stays on this device and only until it is left
-- The flag is local and never travels, so no older app version ever reads it
ALTER TABLE agent_tasks ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_agent_tasks_ephemeral ON agent_tasks (ephemeral) WHERE ephemeral = 1;

-- Search and past-chat recall read this index, so a temporary chat never enters it
DROP TRIGGER IF EXISTS agent_messages_fts_ai;

DROP TRIGGER IF EXISTS agent_messages_fts_au;

CREATE TRIGGER IF NOT EXISTS agent_messages_fts_ai AFTER INSERT ON agent_messages
WHEN NOT EXISTS (SELECT 1 FROM agent_tasks WHERE id = new.task_id AND ephemeral = 1) BEGIN
  INSERT INTO agent_messages_fts(message_id, task_id, content) VALUES (new.id, new.task_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_fts_au AFTER UPDATE OF content ON agent_messages BEGIN
  DELETE FROM agent_messages_fts WHERE message_id = old.id;
  INSERT INTO agent_messages_fts(message_id, task_id, content)
  SELECT new.id, new.task_id, new.content
  WHERE NOT EXISTS (SELECT 1 FROM agent_tasks WHERE id = new.task_id AND ephemeral = 1);
END;
