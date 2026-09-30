-- Carpe Diem device keys die with the Sub Rosa device that asked for them.
-- A row is written in the same transaction as the device revocation or the
-- account deletion, and the maintenance loop delivers it until Carpe Diem
-- acknowledges. There is deliberately no foreign key to accounts: deleting the
-- account is exactly when the row must outlive it.
CREATE TABLE partner_revocations (
 id UUID PRIMARY KEY,
 subject UUID NOT NULL,
 device_id UUID,
 reason TEXT NOT NULL CHECK(reason IN ('device_revoked','signed_out','account_deleted')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 done_at TIMESTAMPTZ,
 last_error TEXT,
 CHECK(reason = 'account_deleted' OR device_id IS NOT NULL)
);
CREATE INDEX partner_revocations_due ON partner_revocations(next_attempt_at) WHERE done_at IS NULL;
