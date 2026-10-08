-- Shared projects and group chats (ADR 0098, docs/security/spaces-protocol.md).
-- The service stays a blind courier: it keeps public keys, signed epoch heads,
-- keys sealed to each member, and objects encrypted under a key it never
-- holds. It authorizes by membership and reads no content.

-- An account's identity: the public bundle (two public keys, self-signed)
-- and the private keys sealed under the account's vault key.
CREATE TABLE identity_keys (
 account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 version BIGINT NOT NULL CHECK (version > 0),
 public_bundle JSONB NOT NULL,
 x25519 TEXT NOT NULL CHECK (char_length(x25519) = 43),
 ed25519 TEXT NOT NULL CHECK (char_length(ed25519) = 43),
 sealed_private TEXT NOT NULL CHECK (octet_length(sealed_private) <= 4096),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A space belongs to its owner and goes with the owner's account.
CREATE TABLE spaces (
 id UUID PRIMARY KEY,
 owner_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 current_epoch BIGINT NOT NULL CHECK (current_epoch > 0),
 next_sequence BIGINT NOT NULL DEFAULT 1,
 used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX spaces_owner ON spaces(owner_account_id);

CREATE TABLE space_members (
 space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK (role IN ('owner','member')),
 joined_epoch BIGINT NOT NULL,
 added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (space_id, account_id)
);
CREATE INDEX space_members_account ON space_members(account_id);

-- One signed head per epoch. The service checks that the epochs follow one
-- another and that the members a head names are the members it keeps, and
-- the members' devices check the signatures and the chain.
CREATE TABLE space_epoch_heads (
 space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 epoch BIGINT NOT NULL CHECK (epoch > 0),
 head JSONB NOT NULL,
 author_account_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (space_id, epoch)
);

-- An epoch key sealed to one member. A member admitted later may also hold
-- the keys of earlier epochs, sealed to them by the owner.
CREATE TABLE space_wrapped_keys (
 space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 epoch BIGINT NOT NULL,
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 sealed TEXT NOT NULL CHECK (octet_length(sealed) <= 1024),
 PRIMARY KEY (space_id, epoch, account_id)
);

-- An invitation is recognised by the hash of a token derived from the link
-- secret, which the service never sees. It is claimed once, by one account,
-- and admitted once.
CREATE TABLE space_invitations (
 id UUID PRIMARY KEY,
 space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 created_by UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL CHECK (char_length(token_hash) = 43),
 payload TEXT NOT NULL CHECK (octet_length(payload) <= 8192),
 expires_at TIMESTAMPTZ NOT NULL,
 claimed_by UUID REFERENCES accounts(id) ON DELETE CASCADE,
 claimed_at TIMESTAMPTZ,
 acceptance JSONB,
 admitted_at TIMESTAMPTZ,
 revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((claimed_by IS NULL) = (acceptance IS NULL))
);
CREATE INDEX space_invitations_space ON space_invitations(space_id);

-- A member who left, with their signed statement, until a remaining member
-- rotates the key without them.
CREATE TABLE space_departures (
 space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 account_id UUID NOT NULL,
 epoch BIGINT NOT NULL,
 statement TEXT NOT NULL CHECK (char_length(statement) = 86),
 rotated_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (space_id, account_id, epoch)
);

-- The objects, in the order the service accepted them. A write is accepted
-- only under the current epoch, from a current member.
CREATE TABLE space_objects (
 space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 sequence BIGINT NOT NULL,
 object_id UUID NOT NULL,
 revision UUID NOT NULL,
 parent_revision UUID,
 kind TEXT NOT NULL CHECK (kind IN ('project','note','file','conversation','message','profile')),
 epoch BIGINT NOT NULL,
 author_account_id UUID NOT NULL,
 ciphertext TEXT NOT NULL CHECK (octet_length(ciphertext) <= 1048576),
 signature TEXT NOT NULL CHECK (char_length(signature) = 86),
 deleted BOOLEAN NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (space_id, sequence),
 UNIQUE (space_id, revision)
);
