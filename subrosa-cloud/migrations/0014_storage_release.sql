-- Releasing room (ADR-0110). A chunk's age lets an owner's sweep leave alone
-- the chunks another device is still uploading, whose manifest has not been
-- written yet. The chunks stored before this file existed are given an age
-- that already clears the sweep's grace: nothing has been accepted since the
-- accounts that need the sweep filled up.
ALTER TABLE blobs ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE blobs SET created_at = now() - interval '7 days';

-- The app version a device last announced, read by the other devices before
-- they write a file format an older app could not open.
ALTER TABLE devices ADD COLUMN app_version TEXT CHECK (app_version IS NULL OR length(app_version) <= 32);
