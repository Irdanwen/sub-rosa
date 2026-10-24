import { describe, expect, it } from "vitest";
import {
  CODE_EVENT_KNOWN_KEYS,
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

  it("declares every key the Rust side writes, nested ones included", () => {
    const known = CODE_EVENT_KNOWN_KEYS;
    const unknownKeys = (value: Record<string, unknown>, keys: string[], where: string) =>
      Object.keys(value)
        .filter((key) => !keys.includes(key))
        .map((key) => `${where}.${key}`);
    const problems: string[] = [];
    const check = (line: Record<string, unknown>, envelope: boolean) => {
      const type = line.type as keyof typeof known.events;
      const keys = [...(envelope ? known.envelope : []), ...(known.events[type] ?? [])];
      problems.push(...unknownKeys(line, keys, String(type)));
      const detail = line.detail as Record<string, unknown> | undefined;
      if (detail) {
        problems.push(...unknownKeys(detail, known.detail, `${type}.detail`));
        if (detail.lines) {
          problems.push(
            ...unknownKeys(detail.lines as Record<string, unknown>, known.lines, `${type}.lines`),
          );
        }
        const edit = detail.edit as Record<string, unknown> | undefined;
        if (edit) {
          problems.push(...unknownKeys(edit, known.edit, `${type}.edit`));
          for (const diagnostic of (edit.diagnostics as Record<string, unknown>[]) ?? []) {
            problems.push(...unknownKeys(diagnostic, known.diagnostic, `${type}.diagnostic`));
          }
        }
      }
      for (const item of (line.items as Record<string, unknown>[] | undefined) ?? []) {
        problems.push(...unknownKeys(item, known.todo, `${type}.item`));
      }
    };
    for (const line of contract.lines) check(line as Record<string, unknown>, true);
    for (const event of recordedRun.events) check(event as Record<string, unknown>, false);
    expect(problems).toEqual([]);
    // And the check itself bites.
    const before = problems.length;
    check({ type: "usage", input_tokens: 1, output_tokens: 1, cached_tokens: 0, extra: 1 }, false);
    expect(problems.length).toBe(before + 1);
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
