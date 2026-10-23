import { describe, expect, it } from "vitest";
import {
  CODE_EVENT_SCHEMA_VERSION,
  CODE_EVENT_TYPES,
  type CodeEvent,
  parseCodeEvent,
  parseCodeEventLine,
} from "../lib/code/events";
// Both files are written by the Rust tests (src-tauri/src/code/), never by
// hand: `UPDATE_CODE_EVENT_FIXTURES=1 cargo test --lib code::` regenerates
// them after a change to the contract, and this suite then says whether the
// TypeScript side still reads what Rust writes.
import contract from "../lib/code/fixtures/code-events.v1.json";
import recordedRun from "../lib/code/fixtures/hermes-v0.19-run.events.json";

describe("the code event contract (ADR-0123)", () => {
  it("is the same schema version and the same list of types on both sides", () => {
    expect(contract.schema).toBe(CODE_EVENT_SCHEMA_VERSION);
    expect(contract.types).toEqual([...CODE_EVENT_TYPES]);
  });

  it("reads every line the Rust side writes, one of each type at least", () => {
    const seen = new Set<string>();
    for (const line of contract.lines) {
      const parsed = parseCodeEventLine(line);
      expect(parsed, JSON.stringify(line)).not.toBeNull();
      if (parsed) seen.add(parsed.type);
    }
    expect([...seen].sort()).toEqual([...CODE_EVENT_TYPES].sort());
  });

  it("reads every event the Hermes adapter made of a real run", () => {
    const events = recordedRun.events as unknown[];
    expect(events.length).toBeGreaterThan(10);
    for (const event of events) {
      expect(parseCodeEvent(event), JSON.stringify(event)).not.toBeNull();
    }
    const types = events.map((event) => (event as CodeEvent).type);
    expect(types[0]).toBe("turn.started");
    expect(types.at(-1)).toBe("turn.finished");
    expect(types).toContain("tool.completed");
    expect(types).toContain("terminal.output");
  });

  it("refuses a line from another schema, an unknown type and a wrong field", () => {
    const line = contract.lines[0] as Record<string, unknown>;
    expect(parseCodeEventLine({ ...line, schema: CODE_EVENT_SCHEMA_VERSION + 1 })).toBeNull();
    expect(parseCodeEvent({ type: "turn.paused", turn_id: "t" })).toBeNull();
    expect(parseCodeEvent({ type: "turn.finished", turn_id: "t", status: "done" })).toBeNull();
    expect(
      parseCodeEvent({ type: "usage", input_tokens: "1", output_tokens: 0, cached_tokens: 0 }),
    ).toBeNull();
    expect(
      parseCodeEvent({
        type: "tool.completed",
        call_id: "c",
        name: "patch",
        kind: "edit",
        ok: true,
        detail: { edit: { added: 1 } },
      }),
    ).toBeNull();
    expect(
      parseCodeEvent({
        type: "todo.updated",
        items: [{ content: "x", status: "blocked" }],
      }),
    ).toBeNull();
  });

  it("leaves optional fields optional", () => {
    expect(
      parseCodeEvent({ type: "tool.started", call_id: "c", name: "web_extract", kind: "other" }),
    ).not.toBeNull();
    expect(
      parseCodeEvent({ type: "run.finished", status: "budget_exceeded", turns: 2 }),
    ).not.toBeNull();
  });
});
