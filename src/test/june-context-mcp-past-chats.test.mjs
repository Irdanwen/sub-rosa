import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The desktop agent reaches the user's other chats through the
 * `search_past_chats` tool of src-tauri/src/hermes/june_context_mcp.py
 * (ADR-0081). It reads general chats only, never a custom assistant's, and it
 * is withheld by --memory=off and by --past-chats=off. Driven with the
 * machine's python3 over a synthetic database, like june-context-mcp.test.mjs.
 */

const SCRIPT = `
import json, sqlite3, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import june_context_mcp as m
db = Path(sys.argv[2])
c = sqlite3.connect(db)
c.executescript('''
CREATE TABLE agent_tasks(id TEXT PRIMARY KEY, title TEXT, safety_profile TEXT, hermes_session_id TEXT);
CREATE TABLE session_folders(session_id TEXT, folder_id TEXT);
CREATE TABLE project_settings(id TEXT PRIMARY KEY, folder_id TEXT, memory_mode TEXT);
CREATE TABLE agent_messages(id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT, created_at TEXT);
CREATE TABLE assistant_conversations(task_id TEXT PRIMARY KEY);
CREATE VIRTUAL TABLE agent_messages_fts USING fts5(message_id UNINDEXED, task_id UNINDEXED, content, tokenize='unicode61 remove_diacritics 2');
INSERT INTO agent_tasks VALUES('c1','Camping gear','general',NULL);
INSERT INTO agent_tasks VALUES('c2','A story','custom_assistant',NULL);
INSERT INTO agent_tasks VALUES('c3','Owned','general',NULL);
INSERT INTO assistant_conversations VALUES('c3');
INSERT INTO agent_messages VALUES('m1','c1','user','Which tent for the Lyon trip?','2026-09-01T10:00:00Z');
INSERT INTO agent_messages VALUES('m2','c1','assistant','A light two person tent fits the Lyon trip.','2026-09-01T10:01:00Z');
INSERT INTO agent_messages VALUES('m3','c2','user','Write about a tent in Lyon','2026-09-02T10:00:00Z');
INSERT INTO agent_messages VALUES('m4','c3','user','The Lyon tent again','2026-09-03T10:00:00Z');
INSERT INTO agent_messages_fts SELECT id, task_id, content FROM agent_messages;
''')
c.commit(); c.close()
def names(memory, past):
    reply = m.handle_message(db, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, memory, "", past)
    return [tool["name"] for tool in reply["result"]["tools"]]
def call(memory, past):
    reply = m.handle_message(db, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "search_past_chats", "arguments": {"query": "tent Lyon"}}}, memory, "", past)
    return "error" in reply
out = {
    "search": m.search_past_chats(db, {"query": "Which tent for Lyon?"}),
    "empty": m.search_past_chats(db, {"query": "the"}),
    "toolsOn": names(True, True),
    "toolsPastOff": names(True, False),
    "toolsMemoryOff": names(False, True),
    "refusedPastOff": call(True, False),
    "refusedMemoryOff": call(False, True),
    "allowed": call(True, True),
}
print(json.dumps(out))
`;

function runPython() {
  const dir = mkdtempSync(join(tmpdir(), "june-mcp-past-"));
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
    // No python3 on this machine: the Rust side of the same search is covered
    // by memory::past_chats's own tests.
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

describe("june_context_mcp search_past_chats", () => {
  const result = runPython();
  const maybe = result ? it : it.skip;

  maybe("finds what was said in other general chats, never an assistant's", () => {
    const ids = result?.search.items.map((item) => item.conversationId);
    expect(ids.length).toBe(2);
    expect(new Set(ids)).toEqual(new Set(["c1"]));
    expect(result?.search.items[0].conversation).toBe("Camping gear");
    expect(result?.search.items[0].date).toBe("2026-09-01");
  });

  maybe("asks for keywords when the query has none", () => {
    expect(result?.empty.items).toEqual([]);
    expect(result?.empty.message).toBeTruthy();
  });

  maybe("is advertised and answered only while memory and past chats are on", () => {
    expect(result?.toolsOn).toContain("search_past_chats");
    expect(result?.toolsOn).toContain("search_user_memories");
    expect(result?.toolsPastOff).not.toContain("search_past_chats");
    expect(result?.toolsPastOff).toContain("search_user_memories");
    expect(result?.toolsMemoryOff).not.toContain("search_past_chats");
    expect(result?.refusedPastOff).toBe(true);
    expect(result?.refusedMemoryOff).toBe(true);
    expect(result?.allowed).toBe(false);
  });
});
