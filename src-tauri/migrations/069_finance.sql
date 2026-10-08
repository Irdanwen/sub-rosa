-- Finances (ADR-0099): bank statements the person imported themselves (CSV,
-- OFX or QFX, camt.053). No bank is ever contacted and no aggregator sees an
-- account. Everything stays on this device unless the person switches on
-- finance sync, which sends transactions and rules with their account.

-- One row per statement file read, for the history and so the same file
-- read twice is recognised by its digest. format is csv, ofx or camt053.
CREATE TABLE IF NOT EXISTS bank_statements (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('csv', 'ofx', 'camt053')),
  preset TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL DEFAULT '',
  digest TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);

-- One booked transaction. Amounts are signed minor units (cents), negative
-- for money out. dedup_key is the bank's own reference when the statement
-- has one, otherwise a digest of account, day, amount and description with
-- the occurrence within the file, so reading an overlapping statement adds
-- only what is new. id is a name-based UUID of dedup_key, so two devices
-- importing one statement make one object. balance_minor is the balance
-- after the transaction when the statement gives or implies it.
-- category_source is empty (none yet), rule or person. A person's choice is
-- never overwritten by a rule. suggestion is a category the model proposed
-- and the person has not confirmed yet. It stays on this device.
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL DEFAULT '',
  booked_on TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  counterparty TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  balance_minor INTEGER,
  category TEXT NOT NULL DEFAULT '',
  category_source TEXT NOT NULL DEFAULT '' CHECK (category_source IN ('', 'rule', 'person')),
  suggestion TEXT NOT NULL DEFAULT '',
  statement_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_booked ON transactions(booked_on);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);

-- Categorisation rules, first match by position wins. pattern is matched
-- without regard to case against the description and the counterparty, as
-- plain text or, when is_regex is 1, as a regular expression (the budget
-- engine's rules.json is imported that way).
CREATE TABLE IF NOT EXISTS finance_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  is_regex INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- This device's choice, never synchronised: whether finances travel with
-- the account at all.
CREATE TABLE IF NOT EXISTS finance_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sync INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO finance_settings (id, sync, updated_at) VALUES (1, 0, '');
