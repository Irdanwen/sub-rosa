-- A share is an envelope the service cannot open. The key that opens it is
-- generated per share and travels in a URL fragment, which never reaches a
-- server, so nothing here is content: an owner, a count, a deadline, and the
-- opaque blob ids the ciphertext lives in.
--
-- An expiry is mandatory by column, not by convention. Revoking stops the
-- service from answering; it cannot reach a copy somebody already downloaded,
-- and the product says so where the link is made (ADR 0050).
CREATE TABLE shares (
 id UUID PRIMARY KEY,
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 blobs INTEGER NOT NULL CHECK (blobs BETWEEN 1 AND 2049),
 bytes BIGINT NOT NULL CHECK (bytes >= 0)
);
CREATE INDEX shares_account ON shares(account_id, created_at DESC);
CREATE INDEX shares_release ON shares(expires_at) WHERE revoked_at IS NULL;

-- Position 0 is the head: the sealed document that names every other chunk and
-- carries its digest. The reader asks for a position, never a blob id, so one
-- share can never be made to serve another one's bytes.
--
-- A blob belongs to at most one share, and a share never reuses a blob the
-- library already holds. That is what makes releasing a share a safe delete:
-- the service cannot read the manifests that would tell it who else is using
-- these bytes, so exclusivity has to be a constraint rather than a hope.
CREATE TABLE share_blobs (
 share_id UUID NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK (position >= 0),
 account_id UUID NOT NULL,
 blob_id UUID NOT NULL,
 PRIMARY KEY (share_id, position),
 UNIQUE (account_id, blob_id),
 FOREIGN KEY (account_id, blob_id) REFERENCES blobs(account_id, id) ON DELETE CASCADE
);
