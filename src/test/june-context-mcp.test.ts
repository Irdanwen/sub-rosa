import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The desktop agent reads the notes through src-tauri/src/hermes/june_context_mcp.py.
 * Its search uses the retrieval "Ask your notes" uses (ADR-0044): any of the
 * question's content words, over the notes and the transcripts, best first,
 * with a substring fallback for a database without the index. This drives
 * the real module with the machine's python3 over a synthetic database.
 */

const SCRIPT = `
import json, sqlite3, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import june_context_mcp as m
db = Path(sys.argv[2])
c = sqlite3.connect(db)
c.executescript('''
CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, generated_content TEXT, edited_content TEXT, processing_status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE transcripts(id TEXT PRIMARY KEY, note_id TEXT, text TEXT, created_at TEXT, turn_index INTEGER);
CREATE VIRTUAL TABLE notes_fts USING fts5(note_id UNINDEXED, title, content, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE transcripts_fts USING fts5(transcript_id UNINDEXED, note_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
INSERT INTO notes VALUES('n1','Infra sync','La migration du cluster vers Hetzner est lundi.',NULL,'ready','2026-09-01','2026-09-01');
INSERT INTO notes VALUES('n2','Budget','Le budget tient pour le trimestre.',NULL,'ready','2026-09-02','2026-09-02');
INSERT INTO transcripts VALUES('t1','n2','On a aussi parle de la migration, mais brievement.','2026-09-02',0);
INSERT INTO notes_fts VALUES('n1','Infra sync','La migration du cluster vers Hetzner est lundi.');
INSERT INTO notes_fts VALUES('n2','Budget','Le budget tient pour le trimestre.');
INSERT INTO transcripts_fts VALUES('t1','n2','On a aussi parle de la migration, mais brievement.');
''')
c.commit(); c.close()
out = {}
out["question"] = m.search_meeting_notes(db, {"query": "Quand est-ce qu'on migre le cluster vers Hetzner ?"})
out["word"] = m.search_meeting_notes(db, {"query": "migration"})
c = sqlite3.connect(db); c.execute('DROP TABLE notes_fts'); c.commit(); c.close()
out["fallback"] = m.search_meeting_notes(db, {"query": "budget"})
out["recent"] = m.search_meeting_notes(db, {"query": ""})
print(json.dumps(out))
`;

function runPython(): Record<string, { terms: string[]; items: Array<{ id: string }> }> | null {
  const dir = mkdtempSync(join(tmpdir(), "june-mcp-"));
  const script = join(dir, "drive.py");
  writeFileSync(script, SCRIPT);
  try {
    const stdout = execFileSync(
      "python3",
      [script, join(process.cwd(), "src-tauri/src/hermes"), join(dir, "notes.sqlite3")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(stdout);
  } catch (error) {
    // No python3 on this machine, or one without FTS5: the Rust side of the
    // same retrieval is covered by its own tests; this one only runs where it can.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

describe("june_context_mcp search_meeting_notes", () => {
  const result = runPython();
  const maybe = result ? it : it.skip;

  maybe(
    "reduces a question to its content words and ranks the note that holds most of them first",
    () => {
      const question = result?.question;
      expect(question?.terms).toEqual(["migre", "cluster", "vers", "hetzner"]);
      expect(question?.items.map((item) => item.id)).toEqual(["n1"]);
    },
  );

  maybe("reads the transcripts too, after the notes", () => {
    expect(result?.word.items.map((item) => item.id)).toEqual(["n1", "n2"]);
  });

  maybe(
    "falls back to a substring search when the index is not there, and lists recents for an empty query",
    () => {
      expect(result?.fallback.items.map((item) => item.id)).toEqual(["n2"]);
      expect(result?.recent.items.map((item) => item.id)).toEqual(["n2", "n1"]);
    },
  );
});
