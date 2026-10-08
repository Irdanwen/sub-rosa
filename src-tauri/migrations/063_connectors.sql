-- Connectors (ADR-0092): remote MCP servers and the built-in Google and
-- Microsoft tools, on every shell. A connector is a definition that travels
-- with the account settings. Its tokens never do: they live in this device's
-- keychain, and nothing here holds one.
-- auth is oauth, none, google or microsoft. catalog_id names the catalog entry
-- it came from, empty for a custom connector. tool_policy maps a tool name to
-- allow, ask or deny, and a tool it does not name follows the default the
-- tool's own hints suggest.
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  catalog_id TEXT NOT NULL DEFAULT '',
  auth TEXT NOT NULL DEFAULT 'oauth',
  enabled INTEGER NOT NULL DEFAULT 1,
  tool_policy TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- What this device knows about a connector and never synchronises: the OAuth
-- client it registered (a public client id, not a secret), the tools the
-- server listed last, and whether the last attempt worked.
CREATE TABLE IF NOT EXISTS connector_state (
  connector_id TEXT PRIMARY KEY,
  oauth_client TEXT,
  tools TEXT NOT NULL DEFAULT '[]',
  server_info TEXT,
  tools_fetched_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  updated_at TEXT NOT NULL
);

-- One connector call the assistant made or asked to make. status is pending
-- (waiting for the person), running, done, failed or denied. A pending row is
-- the durable proposal behind a confirmation card, so a call asked for before
-- the phone locked is still there to approve when it wakes. Kept here.
CREATE TABLE IF NOT EXISTS connector_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connector_calls_task ON connector_calls(task_id, created_at);

-- An interactive view a connector returned (a ui resource), kept so the card
-- that shows it still has it after a restart. html is bounded by the code.
CREATE TABLE IF NOT EXISTS connector_app_resources (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  uri TEXT NOT NULL,
  html TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT '',
  tool_output TEXT,
  created_at TEXT NOT NULL
);

-- A connector event that starts an assignment run: a new issue, a new event,
-- a new message matching a query, or a resource the server says changed.
-- Evaluated by this device while the app is open, so it stays here. seen
-- holds the ids already reported, so a restart does not fire them again.
CREATE TABLE IF NOT EXISTS connector_triggers (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  seen TEXT NOT NULL DEFAULT '[]',
  armed INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connector_triggers_assignment ON connector_triggers(assignment_id);

-- The connectors a deep research run may search, chosen when it started.
CREATE TABLE IF NOT EXISTS research_connector_sources (
  run_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  PRIMARY KEY (run_id, connector_id)
)
