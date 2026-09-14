CREATE TABLE accounts (
 id UUID PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), next_sequence BIGINT NOT NULL DEFAULT 0,
 used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0), UNIQUE (issuer, subject)
);
CREATE TABLE devices (
 id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ
);
CREATE TABLE sessions (
 token_hash BYTEA PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 device_id UUID REFERENCES devices(id) ON DELETE CASCADE, browser BOOLEAN NOT NULL,
 authenticated_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 CHECK ((browser AND device_id IS NULL) OR (NOT browser AND device_id IS NOT NULL))
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE TABLE login_attempts (
 state_hash BYTEA PRIMARY KEY, browser_hash BYTEA NOT NULL, verifier TEXT NOT NULL,
 nonce TEXT NOT NULL, return_to TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE TABLE device_requests (
 id UUID PRIMARY KEY, challenge BYTEA NOT NULL, code_hash BYTEA UNIQUE NOT NULL, name TEXT NOT NULL,
 account_id UUID REFERENCES accounts(id) ON DELETE CASCADE, authenticated_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes', last_poll TIMESTAMPTZ,
 consumed BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE revisions (
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 sequence BIGINT NOT NULL, operation_id UUID NOT NULL, operation_hash BYTEA NOT NULL,
 object_id UUID NOT NULL, revision UUID NOT NULL, parent_revision UUID,
 kind TEXT NOT NULL CHECK(kind IN ('note','folder','transcript','memory','conversation','settings','usage','artifact','tombstone')),
 ciphertext TEXT NOT NULL, deleted BOOLEAN NOT NULL, conflict BOOLEAN NOT NULL,
 device_id UUID, is_head BOOLEAN NOT NULL DEFAULT true,
 PRIMARY KEY(account_id, sequence), UNIQUE(account_id, operation_id), UNIQUE(account_id, revision)
);
CREATE INDEX revisions_heads ON revisions(account_id, object_id) WHERE is_head;
CREATE TABLE vaults (
 account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 version BIGINT NOT NULL CHECK(version > 0), envelope JSONB NOT NULL
);
CREATE TABLE blobs (
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id UUID NOT NULL,
 bytes BIGINT NOT NULL CHECK(bytes >= 0), digest BYTEA NOT NULL, PRIMARY KEY(account_id,id)
);
CREATE TABLE blob_intents (
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id UUID NOT NULL,
 bytes BIGINT NOT NULL CHECK(bytes >= 0), digest BYTEA NOT NULL, PRIMARY KEY(account_id,id)
);
-- Durable storage deletion queue deliberately survives account removal.
CREATE TABLE blob_deletions (key TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE rate_limits (key BYTEA PRIMARY KEY, window_start TIMESTAMPTZ NOT NULL DEFAULT now(), count INTEGER NOT NULL DEFAULT 1);
CREATE TABLE pairing_requests (
 id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 requester_hash BYTEA NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 envelope TEXT, expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '5 minutes'
);
