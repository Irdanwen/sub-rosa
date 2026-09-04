-- What left the machine (2026-09-03)
--
-- Sub Rosa's one promise is that nothing leaves except the requests you make
-- of a model, to the endpoint you configured. Settings > Privacy showed the
-- list of hosts the binary can reach, which is the promise stated. This table
-- is the promise kept: one row per outbound request, written by the process
-- that sent it, so a person can read what went where, when, how big, and for
-- what, without trusting the sentence.
--
-- It records shapes, never contents: the host, the path's purpose, the byte
-- counts, the status, the duration, the model when the request named one.
-- The prompt itself is not here, on purpose. The ledger must be safe to show
-- and safe to leave on disk.
--
-- Rows older than ninety days are pruned on launch. The count is the point,
-- not the history.

CREATE TABLE IF NOT EXISTS egress_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  host TEXT NOT NULL,
  purpose TEXT NOT NULL,
  method TEXT NOT NULL,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  status INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  note_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_egress_ledger_at ON egress_ledger (at DESC);
CREATE INDEX IF NOT EXISTS idx_egress_ledger_note ON egress_ledger (note_id);
