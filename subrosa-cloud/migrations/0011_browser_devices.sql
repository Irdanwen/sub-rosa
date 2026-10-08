-- A browser can become a device of its account (ADR 0096). Its device key is a
-- WebCrypto P-256 key the browser generated non-extractable, so the service
-- keeps the public half and the RFC 7638 thumbprint, never anything secret.
-- A browser device holds no bearer session and no device secret: it proves
-- itself on each request with a signature from that key, next to the
-- ordinary browser session of the same account.
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'native' CHECK(kind IN ('native','browser'));
ALTER TABLE devices ADD COLUMN public_x TEXT;
ALTER TABLE devices ADD COLUMN public_y TEXT;
ALTER TABLE devices ADD COLUMN jkt TEXT;
ALTER TABLE devices ADD CONSTRAINT devices_browser_key
 CHECK ((kind = 'browser') = (jkt IS NOT NULL AND public_x IS NOT NULL AND public_y IS NOT NULL));
CREATE UNIQUE INDEX devices_jkt ON devices(jkt) WHERE jkt IS NOT NULL;

-- Admission by another device is a pairing the service watched happen: the
-- approving session's device is written down, and the request can admit one
-- browser device once, within the five minutes it lives anyway.
ALTER TABLE pairing_requests ADD COLUMN approved_by_device UUID REFERENCES devices(id) ON DELETE CASCADE;
ALTER TABLE pairing_requests ADD COLUMN approved_at TIMESTAMPTZ;

-- Admission by the recovery key compares a value derived from that key with
-- this hash. Whoever writes a vault envelope holds its recovery key, so the
-- verifier travels with the envelope and a new envelope without one clears it.
ALTER TABLE vaults ADD COLUMN admission_verifier BYTEA;

-- A device proof is single use. Rows live two minutes, the window in which a
-- proof's issue time is accepted at all.
CREATE TABLE device_proofs (
 jti_hash BYTEA PRIMARY KEY,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX device_proofs_expiry ON device_proofs(expires_at);
