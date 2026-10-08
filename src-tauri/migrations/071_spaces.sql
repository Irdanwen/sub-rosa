-- Shared projects and group chats (ADR-0098). A space's decrypted content is
-- kept here like every other local row (ADR-0039). Space keys are not: they
-- are unwrapped from the service with the identity key each time they are
-- needed and live in memory only. The identity's private keys live in the
-- keyring and, sealed under the vault key, on the service.

CREATE TABLE IF NOT EXISTS space_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  identity_json TEXT
);

-- state is pending (accepted, waiting for the owner), active, left, removed.
-- anchor_json is the identity the chain is verified from the first time:
-- this account for a space it created, the inviter named in the link
-- otherwise.
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  owner_account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  source_folder_id TEXT,
  anchor_json TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every head this device verified. The latest one is what a later answer
-- from the service is checked against, so an older one is a rollback.
CREATE TABLE IF NOT EXISTS space_heads (
  space_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  head_json TEXT NOT NULL,
  PRIMARY KEY (space_id, epoch)
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (space_id, account_id)
);

-- The latest accepted revision of each object, decrypted. A message is an
-- object with a single revision.
CREATE TABLE IF NOT EXISTS space_objects (
  space_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  author_account_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, object_id)
);
CREATE INDEX IF NOT EXISTS space_objects_kind ON space_objects(space_id, kind, sequence);

-- Writes waiting for the service (ADR-0018). The sealed form is frozen
-- before the first send, so a retry after a lost answer sends the same
-- bytes. A rotation in between seals it again under a new revision.
CREATE TABLE IF NOT EXISTS space_outbox (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision TEXT NOT NULL,
  parent_revision TEXT,
  data_json TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER,
  ciphertext TEXT,
  signature TEXT,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- The owner's side of an invitation. The secret is what verifies the
-- invitee's acceptance, so it stays on the device that made the link.
CREATE TABLE IF NOT EXISTS space_invitations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- An assistant reply a member asked for. It runs on that member's device
-- with that member's key, and is re-driven after a suspension.
CREATE TABLE IF NOT EXISTS space_turns (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  reply_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
