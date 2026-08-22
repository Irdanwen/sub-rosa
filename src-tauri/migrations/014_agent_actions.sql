-- What the assistant proposed and the user accepted.
-- A chat block is text inside an immutable message, so "done" cannot live
-- there, or a reopened conversation would offer the same button again for
-- something already done. The row is the truth and the card reads it, which
-- is the ADR-0018 pattern applied to an interface.
-- Rows are written only on success, so a failure honestly leaves the button.
-- NOTE no semicolons in these comments, run_migrations splits on them
CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_actions_unique
  ON agent_actions(proposal_id, action_id)
