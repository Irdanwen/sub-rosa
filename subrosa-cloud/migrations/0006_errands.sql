-- A tenth kind, for the one object that is an instruction rather than a record.
--
-- Everything else in this journal is history: a note that exists, a memory that
-- was extracted, a file that was written. An errand is a person on one of their
-- devices asking another of their devices to do something, and it is the single
-- deliberate exception to "incoming state is inert" (ADR 0049, ADR 0054).
--
-- The service learns nothing from the name. The ciphertext is opaque as ever,
-- the link inside it never reaches here, and nothing on this side decides
-- whether an errand runs: the device it names does, and only if its owner
-- switched errands on.
ALTER TABLE revisions DROP CONSTRAINT revisions_kind_check;
ALTER TABLE revisions ADD CONSTRAINT revisions_kind_check CHECK (kind IN ('note','folder','transcript','memory','conversation','settings','usage','artifact','tombstone','errand'));
