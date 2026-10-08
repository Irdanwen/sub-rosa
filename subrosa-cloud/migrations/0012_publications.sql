-- Public content (ADR 0097). Everything else this service holds is ciphertext
-- for one reader. These tables hold plaintext for every reader, on purpose:
-- a page, a profile or a catalog listing exists to be read by strangers. They
-- are written only on an explicit publish, removed on unpublish, and never
-- derived from the encrypted library.
--
-- What is stored is what is shown. A page keeps its sanitized HTML and a
-- digest of the source it came from, never the source itself.

CREATE TABLE public_profiles (
 account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 handle TEXT NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$'),
 display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
 bio TEXT NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
 avatar BYTEA CHECK (avatar IS NULL OR octet_length(avatar) <= 262144),
 avatar_type TEXT CHECK (avatar_type IN ('image/png','image/jpeg','image/webp')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 taken_down_at TIMESTAMPTZ,
 CHECK ((avatar IS NULL) = (avatar_type IS NULL))
);

CREATE TABLE published_pages (
 id UUID PRIMARY KEY,
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,62})[a-z0-9]$'),
 title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
 kind TEXT NOT NULL CHECK (kind IN ('note','canvas')),
 source_id TEXT NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 64),
 source_digest TEXT NOT NULL,
 html TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK (bytes >= 0),
 site_id UUID,
 position INTEGER NOT NULL DEFAULT 0,
 published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 taken_down_at TIMESTAMPTZ,
 UNIQUE (account_id, source_id)
);
CREATE INDEX published_pages_account ON published_pages(account_id, updated_at DESC);

-- A site is a set of the owner's pages with a home page and an order. It has
-- no address of its own: its home page's address is the site's.
CREATE TABLE published_sites (
 id UUID PRIMARY KEY,
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
 home_page_id UUID REFERENCES published_pages(id) ON DELETE SET NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 taken_down_at TIMESTAMPTZ
);
CREATE INDEX published_sites_account ON published_sites(account_id);
ALTER TABLE published_pages ADD CONSTRAINT published_pages_site
 FOREIGN KEY (site_id) REFERENCES published_sites(id) ON DELETE SET NULL;
CREATE INDEX published_pages_site ON published_pages(site_id, position);

CREATE TABLE assistant_listings (
 id UUID PRIMARY KEY,
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 64),
 name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
 description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
 category TEXT NOT NULL CHECK (category IN ('writing','research','learning','productivity','creative','coding','lifestyle','other')),
 instructions TEXT NOT NULL,
 starter TEXT NOT NULL DEFAULT '',
 permissions JSONB NOT NULL DEFAULT '[]',
 refs JSONB NOT NULL DEFAULT '[]',
 bytes INTEGER NOT NULL CHECK (bytes >= 0),
 import_count BIGINT NOT NULL DEFAULT 0,
 published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 taken_down_at TIMESTAMPTZ,
 UNIQUE (account_id, source_id)
);
CREATE INDEX assistant_listings_catalog ON assistant_listings(category, import_count DESC, updated_at DESC) WHERE taken_down_at IS NULL;
CREATE INDEX assistant_listings_account ON assistant_listings(account_id);

-- A report names a target and a reason. The reporter is a keyed hash of the
-- address the report came from, kept only so one address counts once.
CREATE TABLE content_reports (
 id UUID PRIMARY KEY,
 target_kind TEXT NOT NULL CHECK (target_kind IN ('page','profile','assistant')),
 target_id UUID NOT NULL,
 reason TEXT NOT NULL CHECK (reason IN ('spam','abuse','illegal','privacy','other')),
 detail TEXT NOT NULL DEFAULT '' CHECK (char_length(detail) <= 500),
 reporter_hash BYTEA NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 resolved_at TIMESTAMPTZ,
 UNIQUE (target_kind, target_id, reporter_hash)
);
CREATE INDEX content_reports_open ON content_reports(created_at) WHERE resolved_at IS NULL;

-- What the operator took down outlives the row it took down. The digest of
-- the content refuses an identical copy under a new address, and the count
-- per account is what suspends publishing after repeated takedowns. Deleting
-- the account keeps the digest: a fresh account does not wash a copy clean.
CREATE TABLE takedowns (
 id UUID PRIMARY KEY,
 account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
 target_kind TEXT NOT NULL CHECK (target_kind IN ('page','profile','assistant','site')),
 target_id UUID NOT NULL,
 content_digest TEXT,
 reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX takedowns_account ON takedowns(account_id);
CREATE INDEX takedowns_digest ON takedowns(content_digest) WHERE content_digest IS NOT NULL;
