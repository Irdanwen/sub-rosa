CREATE TABLE IF NOT EXISTS assistants (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 instructions TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
 opening_message TEXT NOT NULL DEFAULT '', tools_json TEXT NOT NULL DEFAULT '[]',
 allow_notes INTEGER NOT NULL DEFAULT 0, allow_memory INTEGER NOT NULL DEFAULT 0,
 avatar_ref TEXT, cover_ref TEXT, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_references (
 id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 name TEXT NOT NULL, format TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'queued', error TEXT, note_id TEXT, file_name TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_references_owner ON assistant_references(assistant_id);
