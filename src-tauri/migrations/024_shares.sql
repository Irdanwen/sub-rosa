-- What a link was made of, kept here and nowhere else. The service stores the
-- ciphertext and the deadline, never the title, so without this row a list of
-- live links would read as a list of identifiers. Local by design and by
-- consequence: a link made on one device shows untitled on another, which is
-- the honest cost of the service not knowing what it is holding.
CREATE TABLE IF NOT EXISTS account_shares (
 id TEXT PRIMARY KEY, note_id TEXT, title TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_shares_note ON account_shares(note_id);
