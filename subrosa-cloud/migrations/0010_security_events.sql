-- What happened to an account's access, read back by its owner on the account
-- page: sign-ins and sign-outs, devices admitted, renamed and revoked, a
-- replayed refresh token, a vault key handed to another device, passkeys,
-- the vault envelope, and the Carpe Diem keys the service vouched for or saw
-- revoked.
--
-- Append-only and short-lived. A row is written in the transaction of the
-- action it describes, and maintenance deletes it after ninety days. Nothing
-- here is new information about the person. The device name is a copy of the
-- label already kept in devices, taken at the time so a later rename does not
-- rewrite what happened. No network address, user agent or location is
-- stored, and an account deletion takes its history with it.
CREATE TABLE security_events (
 id UUID PRIMARY KEY,
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('signed_in','signed_in_passkey','signed_out','device_added','device_signed_in','device_renamed','device_revoked','device_signed_out','refresh_reuse_blocked','pairing_approved','passkey_added','passkey_removed','vault_created','vault_updated','carpe_diem_key_requested','carpe_diem_key_revoked','sessions_reset')),
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 device_name TEXT
);
CREATE INDEX security_events_account ON security_events(account_id, occurred_at DESC);
CREATE INDEX security_events_expiry ON security_events(occurred_at);
