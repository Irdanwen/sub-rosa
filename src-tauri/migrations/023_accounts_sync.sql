-- Account metadata only. Access tokens and vault keys live in the OS keyring.
CREATE TABLE IF NOT EXISTS account_sync_control (
 id INTEGER PRIMARY KEY CHECK(id = 1), server_url TEXT, account_id TEXT,
 account_json TEXT, device_id TEXT, enabled INTEGER NOT NULL DEFAULT 0,
 applying INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0,
 vault_exists INTEGER, recovery_confirmed INTEGER NOT NULL DEFAULT 0,
 last_synced_at TEXT, last_sync_error TEXT
);
INSERT OR IGNORE INTO account_sync_control(id) VALUES (1);
CREATE TABLE IF NOT EXISTS account_sync_outbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
 object_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
 deleted INTEGER NOT NULL DEFAULT 0, ciphertext TEXT, parent_revision TEXT, resolved_revisions TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS account_sync_outbox_object ON account_sync_outbox(object_id);
CREATE TABLE IF NOT EXISTS account_sync_heads (
 object_id TEXT PRIMARY KEY, revision TEXT NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sync_inbox (
 revision TEXT PRIMARY KEY, object_id TEXT NOT NULL, kind TEXT NOT NULL,
 ciphertext TEXT NOT NULL, parent_revision TEXT, operation_id TEXT,
 deleted INTEGER NOT NULL, sequence INTEGER NOT NULL, applied INTEGER NOT NULL DEFAULT 0, resolved_revisions TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS account_sync_conflicts (
 id TEXT PRIMARY KEY, object_id TEXT NOT NULL, kind TEXT NOT NULL,
 ciphertext TEXT NOT NULL, parent_revision TEXT, operation_id TEXT,
 deleted INTEGER NOT NULL, created_at TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, resolved_revisions TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS account_sync_settings (
 id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, revision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_note_folders (
 id TEXT PRIMARY KEY, note_id TEXT NOT NULL, folder_id TEXT NOT NULL,
 assigned_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS account_note_folders_pair ON account_note_folders(note_id,folder_id);
CREATE TABLE IF NOT EXISTS account_usage (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL, day TEXT NOT NULL,
 model TEXT NOT NULL, request_count INTEGER NOT NULL DEFAULT 0,
 request_bytes INTEGER NOT NULL DEFAULT 0, response_bytes INTEGER NOT NULL DEFAULT 0,
 UNIQUE(device_id,day,model)
);
CREATE TABLE IF NOT EXISTS account_file_manifests (
 id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL,
 format TEXT NOT NULL, chunks_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_file_uploads (
 artifact_id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL, bytes INTEGER NOT NULL,
 modified TEXT NOT NULL, next_offset INTEGER NOT NULL DEFAULT 0,
 chunks_json TEXT NOT NULL DEFAULT '[]', pending_blob_id TEXT, pending_ciphertext TEXT,
 pending_bytes INTEGER, pending_digest TEXT, completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_file_downloads (
 manifest_id TEXT PRIMARY KEY, next_chunk INTEGER NOT NULL DEFAULT 0,
 completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_billing (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, sampled_at TEXT NOT NULL,
 available_credits REAL NOT NULL, escrow_credits REAL NOT NULL, rail TEXT,
 price_multiplier REAL
);
CREATE TABLE IF NOT EXISTS account_conversation_backfill (
 profile TEXT NOT NULL, session_id TEXT NOT NULL, last_message_id TEXT,
 PRIMARY KEY(profile,session_id)
);
CREATE TABLE IF NOT EXISTS account_studio_files (
 id TEXT PRIMARY KEY, file_name TEXT NOT NULL, format TEXT NOT NULL,
 bytes INTEGER NOT NULL, created_at TEXT NOT NULL, model TEXT, prompt TEXT
);
CREATE TABLE IF NOT EXISTS account_turn_usage (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL, sampled_at TEXT NOT NULL,
 turns INTEGER NOT NULL, prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
 cached_tokens INTEGER NOT NULL, cost_usdc_micro INTEGER, cache_saved_usdc_micro INTEGER NOT NULL
);
