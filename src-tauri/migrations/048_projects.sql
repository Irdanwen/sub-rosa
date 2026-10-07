-- Projects as a chat surface (ADR-0085). A project is a folder. What it adds
-- lives in two tables keyed to the folder, so nothing changes in the folder
-- row that older devices already read.
-- project_settings carries the instructions and the memory mode. Its id IS
-- the folder id, so two devices editing the same project write one object.
-- project_files carries the files, extracted once like assistant references,
-- stored in the same directory and carried by the same file lane.
-- memories.scope is NULL for the user's own memory and holds the folder id
-- for a memory a project keeps to itself (memory mode "project").
CREATE TABLE IF NOT EXISTS project_settings (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  memory_mode TEXT NOT NULL DEFAULT 'default',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  file_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_files_folder ON project_files(folder_id);

ALTER TABLE memories ADD COLUMN scope TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, disabled, importance);
