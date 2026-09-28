-- Keeps one unsent snapshot per object in the sync outbox
-- The triggers now supersede an unsealed row with the next one for the same
-- object, but outboxes filled before that hold one row per recording
-- checkpoint, thousands for a single object. Only rows never sealed go, and
-- never a resolution, which names the siblings a person acknowledged
DELETE FROM account_sync_outbox
WHERE ciphertext IS NULL
  AND resolved_revisions = '[]'
  AND sequence < (
    SELECT MAX(later.sequence) FROM account_sync_outbox later
    WHERE later.object_id = account_sync_outbox.object_id
      AND later.kind = account_sync_outbox.kind
      AND later.ciphertext IS NULL
      AND later.resolved_revisions = '[]'
  );
