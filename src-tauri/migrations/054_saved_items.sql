-- What a person keeps from a chat (ADR-0088): a reply, a link or a place,
-- saved to the Library. Kept on this device, like reply ratings. It travels
-- only inside an archive the person exports themselves.
-- source_key names what was saved (a reply by conversation and message, a
-- link by its address, a place by its coordinates), so saving twice keeps
-- one row. payload is the item as the card showed it, as JSON.
CREATE TABLE IF NOT EXISTS saved_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'link', 'place')),
  source_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  conversation_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_items_created ON saved_items(created_at);
