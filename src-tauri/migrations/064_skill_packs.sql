-- Skill packs (ADR-0092): a SKILL.md made portable. The description is what
-- the assistant is offered, the body is what it reads when it picks the skill
-- or when the person types its name after a slash. tools lists the tools the
-- pack narrows a turn to, empty for no narrowing. Synchronised as a definition.
CREATE TABLE IF NOT EXISTS skill_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
