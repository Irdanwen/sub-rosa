-- When this device last applied something another device sent
-- Read by the account panel next to the last successful pass
ALTER TABLE account_sync_control ADD COLUMN last_received_at TEXT;
