CREATE TABLE session_families (
 id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 authenticated_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ
);
CREATE TABLE refresh_tokens (
 token_hash BYTEA PRIMARY KEY, family_id UUID NOT NULL REFERENCES session_families(id) ON DELETE CASCADE,
 consumed_at TIMESTAMPTZ
);
ALTER TABLE sessions ADD COLUMN family_id UUID REFERENCES session_families(id) ON DELETE CASCADE;
CREATE INDEX sessions_family ON sessions(family_id);
CREATE INDEX refresh_family ON refresh_tokens(family_id);
-- Existing native bearer sessions must authenticate again after this security upgrade.
DELETE FROM sessions WHERE NOT browser;
