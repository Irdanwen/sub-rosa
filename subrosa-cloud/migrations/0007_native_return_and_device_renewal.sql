-- A native sign-in comes back through the scheme the app registered, so its
-- request carries no human code at all. It ends with a return code that only
-- the operating system running the browser ever receives, and the exchange
-- demands that half alongside the PKCE verifier the app never let go of.
-- Neither half is enough. A stolen start link has the first and not the second,
-- a scheme squatter has the second and not the first.
ALTER TABLE device_requests ALTER COLUMN code_hash DROP NOT NULL;
ALTER TABLE device_requests ADD COLUMN start_hash BYTEA;
ALTER TABLE device_requests ADD COLUMN return_hash BYTEA;
ALTER TABLE device_requests ADD COLUMN rebind_device_id UUID REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE device_requests ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX device_requests_start ON device_requests(start_hash);
-- Exactly one of the two ways in: a user code to read aloud, or a start handle
-- to follow. A row with both would be approvable down either path.
ALTER TABLE device_requests ADD CONSTRAINT device_requests_one_entry
 CHECK ((code_hash IS NULL) <> (start_hash IS NULL));

-- The browser flow and the native flow share this table and the OIDC round
-- trip. Which one is finishing is decided by the row the single-use state
-- consumes, never by anything the caller supplied.
ALTER TABLE login_attempts ADD COLUMN native_request_id UUID REFERENCES device_requests(id) ON DELETE CASCADE;

-- A device authorization outlives its token families. It does not outlive a
-- revocation, and its secret dies with it: revoke_device and the post-restore
-- invalidation both clear secret_hash, so a revoked device cannot readmit
-- itself. authenticated_at is the instant the device was first admitted, and a
-- renewal reuses it, which is why a renewed session can never be recent.
ALTER TABLE devices ADD COLUMN secret_hash BYTEA;
ALTER TABLE devices ADD COLUMN authenticated_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN renewed_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN renew_count INTEGER NOT NULL DEFAULT 0;
UPDATE devices SET authenticated_at = created_at WHERE authenticated_at IS NULL;
ALTER TABLE devices ALTER COLUMN authenticated_at SET DEFAULT now();
ALTER TABLE devices ALTER COLUMN authenticated_at SET NOT NULL;
CREATE UNIQUE INDEX devices_secret_hash ON devices(secret_hash);
