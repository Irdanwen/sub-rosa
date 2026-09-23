-- Local film documents and gallery metadata, with no file paths or media copies
CREATE TABLE IF NOT EXISTS studio_projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TEXT NOT NULL,
    document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_projects_updated_at ON studio_projects(updated_at DESC);
CREATE TABLE IF NOT EXISTS studio_artifact_metadata (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    project_ids TEXT NOT NULL DEFAULT '[]',
    generation TEXT
);
