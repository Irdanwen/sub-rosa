-- Credentials are linked to immutable internal account ids after a recent
-- authenticated migration. No email can select or merge an account.
CREATE TABLE passkeys (
 credential_id BYTEA PRIMARY KEY,
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 credential JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_used_at TIMESTAMPTZ
);
CREATE INDEX passkeys_account ON passkeys(account_id);

-- Each challenge is consumed once, including failed verification. The JSON
-- contains webauthn-rs' opaque server state, never an authenticator secret.
CREATE TABLE passkey_attempts (
 id UUID PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('register','authenticate','native')),
 state JSONB NOT NULL,
 account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
 browser_token_hash BYTEA,
 device_request_id UUID REFERENCES device_requests(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '5 minutes',
 CHECK ((kind='register' AND account_id IS NOT NULL AND browser_token_hash IS NOT NULL AND device_request_id IS NULL)
     OR (kind='authenticate' AND account_id IS NULL AND browser_token_hash IS NULL AND device_request_id IS NULL)
     OR (kind='native' AND account_id IS NULL AND browser_token_hash IS NULL AND device_request_id IS NOT NULL))
);
CREATE INDEX passkey_attempts_expiry ON passkey_attempts(expires_at);
