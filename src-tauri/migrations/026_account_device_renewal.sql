-- Bounds how often a device may ask for a session again after a restart loop
-- Written before the request, read on the next attempt
ALTER TABLE account_sync_control ADD COLUMN renew_attempted_at TEXT;
