-- A chat's folders, synchronised (ADR-0080). session_folders keys a desktop
-- chat by its Hermes session id and a phone chat by its task id, so the
-- mirror carries the id every device knows: the conversation's task id when
-- this device has one for the Hermes session, the session id otherwise.
-- Same shape as account_note_folders, with a deletion flag instead of a row
-- removal so a restore travels like an archive.
CREATE TABLE IF NOT EXISTS account_session_folders (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, folder_id TEXT NOT NULL,
 assigned_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS account_session_folders_pair ON account_session_folders(session_id,folder_id);
