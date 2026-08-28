-- The council: deliberation that issues a verifiable mandate (ADR-0034)
--
-- Three tables, because three things have different lifetimes.
--
-- council_mandates is the cycle: one user request, the seats that were
-- convened on it, the questions they agreed to ask, the mandate they issued,
-- the session that executed it. It outlives the deliberation by design -- the
-- verdict needs to know what was asked, hours later.
--
-- council_turns is the resume unit and the reason a killed run is cheap to
-- restart. One row per seat per phase per round, written the moment that seat
-- answers, so a sitting interrupted at the fourth of five seats resumes at the
-- fifth instead of re-buying the four that already landed. Its primary key is
-- what makes re-driving idempotent.
--
-- council_verdicts is per round rather than per mandate because a retake
-- produces another verdict, and the first one must survive it -- the point of
-- the cycle is being able to see that the second pass fixed what the first
-- one missed.
--
-- dissent_json and cuts_json are what the sitting has to tell the user before
-- they accept: where the seats disagreed and the chair had to choose, and what
-- the caps had to cut out of the mandate. They belong to the sitting rather
-- than to the mandate, which is why they are columns here and not fields of
-- mandate_json -- the mandate is a contract with the agent, and neither of
-- these is part of it.
--
-- session_model is the model the work was actually done on, recorded so the
-- verdict can stay off it. A reviewer sharing weights with the author shares
-- its blind spots, and this is the only place that fact is knowable.
--
-- base_commit is the working folder's HEAD at the moment the agent took the
-- mandate. Without it a verdict can only see the working tree, which is blind
-- to anything the session committed -- and reading a diff against the wrong
-- base is worse than reading no diff, because it looks like an answer.
--
-- rendered_prompt is stored rather than recomputed. It is exactly the string
-- the agent was handed, and the whole feature rests on being able to say so
-- afterwards without trusting that the renderer has not changed since.
--
-- Status of a mandate is deliberating, questions, ready, executing, reviewing,
-- settled or failed. Status of a verdict is running, ready or failed.
--
-- A verdict carries its own prompt_version rather than borrowing the
-- mandate's. A retake can land after an app update, and a verdict written by
-- a newer set of prompts must be tellable from the one it supersedes.
--
-- NOTE: run_migrations naively splits this file on the semicolon character, so
-- no comment here may contain one.

CREATE TABLE IF NOT EXISTS council_mandates (
  id TEXT PRIMARY KEY NOT NULL,
  council_id TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'deliberating',
  seats_json TEXT NOT NULL DEFAULT '[]',
  situation TEXT,
  questions_json TEXT,
  mandate_json TEXT,
  dissent_json TEXT,
  cuts_json TEXT,
  rendered_prompt TEXT,
  session_id TEXT,
  working_dir TEXT,
  base_commit TEXT,
  session_model TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  prompt_version TEXT NOT NULL DEFAULT '',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_council_mandates_status
ON council_mandates (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_council_mandates_session
ON council_mandates (session_id);

CREATE TABLE IF NOT EXISTS council_turns (
  mandate_id TEXT NOT NULL REFERENCES council_mandates(id) ON DELETE CASCADE,
  round INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  failed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mandate_id, round, phase, seat_id)
);

CREATE INDEX IF NOT EXISTS idx_council_turns_mandate
ON council_turns (mandate_id, round, phase);

CREATE TABLE IF NOT EXISTS council_verdicts (
  mandate_id TEXT NOT NULL REFERENCES council_mandates(id) ON DELETE CASCADE,
  round INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  session_id TEXT,
  verdict_json TEXT,
  prompt_version TEXT NOT NULL DEFAULT '',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mandate_id, round)
);

CREATE INDEX IF NOT EXISTS idx_council_verdicts_status
ON council_verdicts (status, updated_at DESC);
