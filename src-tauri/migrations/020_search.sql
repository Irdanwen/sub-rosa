-- Search that reads the notes (2026-09-03)
--
-- Until now the only search was a filter in the webview over the first hundred
-- notes the list had loaded, and a LIKE over titles for the mobile chat. The
-- hundred-and-first note was invisible, and nothing searched a transcript, a
-- memory or a past conversation. ADR-0009 deferred FTS5 until imports landed
-- and they landed in v1.45.0, so this is the migration it was waiting for.
--
-- Four FTS5 tables, one per corpus, each keyed by the row it indexes through
-- an UNINDEXED column. They are standalone (their own copy of the text) rather
-- than external-content tables, because the source tables have TEXT primary
-- keys and external content binds to rowids, which VACUUM may renumber. The
-- copy is the cost of a search that can never point at the wrong row.
--
-- Triggers keep them current. They carry semicolons inside BEGIN ... END, so
-- the runner splits this file with the statement-aware splitter, not on ';'.
-- The backfills at the end are idempotent: they only insert what is missing,
-- since every migration file is replayed on every launch.
--
-- The tokenizer folds accents (remove_diacritics 2) so "reunion" finds
-- "réunion", which matters for a product used in French.

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(note_id, title, content)
  VALUES (new.id, new.title, COALESCE(new.edited_content, new.generated_content, ''));
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE OF title, edited_content, generated_content ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = old.id;
  INSERT INTO notes_fts(note_id, title, content)
  VALUES (new.id, new.title, COALESCE(new.edited_content, new.generated_content, ''));
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = old.id;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
  transcript_id UNINDEXED,
  note_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS transcripts_fts_ai AFTER INSERT ON transcripts BEGIN
  INSERT INTO transcripts_fts(transcript_id, note_id, text) VALUES (new.id, new.note_id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS transcripts_fts_au AFTER UPDATE OF text, note_id ON transcripts BEGIN
  DELETE FROM transcripts_fts WHERE transcript_id = old.id;
  INSERT INTO transcripts_fts(transcript_id, note_id, text) VALUES (new.id, new.note_id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS transcripts_fts_ad AFTER DELETE ON transcripts BEGIN
  DELETE FROM transcripts_fts WHERE transcript_id = old.id;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(memory_id, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF text ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
  INSERT INTO memories_fts(memory_id, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS agent_messages_fts USING fts5(
  message_id UNINDEXED,
  task_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS agent_messages_fts_ai AFTER INSERT ON agent_messages BEGIN
  INSERT INTO agent_messages_fts(message_id, task_id, content) VALUES (new.id, new.task_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_fts_au AFTER UPDATE OF content ON agent_messages BEGIN
  DELETE FROM agent_messages_fts WHERE message_id = old.id;
  INSERT INTO agent_messages_fts(message_id, task_id, content) VALUES (new.id, new.task_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS agent_messages_fts_ad AFTER DELETE ON agent_messages BEGIN
  DELETE FROM agent_messages_fts WHERE message_id = old.id;
END;

INSERT INTO notes_fts(note_id, title, content)
SELECT id, title, COALESCE(edited_content, generated_content, '')
FROM notes
WHERE id NOT IN (SELECT note_id FROM notes_fts);

INSERT INTO transcripts_fts(transcript_id, note_id, text)
SELECT id, note_id, text
FROM transcripts
WHERE id NOT IN (SELECT transcript_id FROM transcripts_fts);

INSERT INTO memories_fts(memory_id, text)
SELECT id, text
FROM memories
WHERE id NOT IN (SELECT memory_id FROM memories_fts);

INSERT INTO agent_messages_fts(message_id, task_id, content)
SELECT id, task_id, content
FROM agent_messages
WHERE id NOT IN (SELECT message_id FROM agent_messages_fts);
