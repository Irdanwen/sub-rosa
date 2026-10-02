-- Transcription chunks (ADR-0071): what each fixed-size slice of a recording
-- came back as, written the moment it lands.
--
-- A microphone recording or a decoded import is cut into fixed chunks and
-- transcribed one after another, each chunk handed the text of the ones before
-- it as context. That text used to live only in memory, so an iPhone that
-- locked mid-transcription, suspended the app and later killed it lost every
-- chunk already paid for, and the retry started again at chunk zero. A row per
-- finished chunk turns that retry into a continuation.
--
-- fingerprint names the cut the rows belong to: the prepared audio's size, the
-- chunk ceiling, the chunk count, the transcription model and the language. A
-- run whose fingerprint differs discards the rows rather than mixing two cuts.
--
-- outcome is text or silent. A silent chunk is remembered too, so a resume does
-- not ask the provider again about a stretch it already judged empty.
--
-- The rows are scaffolding, not history. They are deleted as soon as the note
-- they fed is ready, and the transcript row is what stays.
--
-- NOTE: run_migrations naively splits this file on the semicolon character, so
-- no comment here may contain one.
CREATE TABLE IF NOT EXISTS transcription_chunks (
  audio_artifact_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  language TEXT,
  provider TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (audio_artifact_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_transcription_chunks_note
ON transcription_chunks (note_id);
