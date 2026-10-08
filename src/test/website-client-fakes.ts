// Fakes for the web client's tests: a journal that follows the accounts
// contract (revisions, per-object heads, siblings, idempotent retries), and a
// Carpe Diem operator that streams scripted completions.
import type { Change } from "../../website/src/lib/api";
import { ApiError } from "../../website/src/lib/api";
import type { Operator } from "../../website/src/client/carpe-diem";
import type { PushResult, SyncTransport } from "../../website/src/client/sync";

interface Operation {
  operation_id: string;
  object_id: string;
  parent_revision: string | null;
  resolved_revisions?: string[];
  kind: string;
  ciphertext: string;
  deleted: boolean;
}

/** The service's journal, in memory, with the rules of `POST /api/v1/sync`. */
export class FakeJournal {
  changes: Change[] = [];
  heads = new Map<string, Set<string>>();
  results = new Map<string, { result: PushResult; ciphertext: string }>();
  pushes: Operation[] = [];
  failNextPush = 0;
  private counter = 0;

  revision() {
    this.counter += 1;
    return `0192f000-0000-7000-8000-${String(this.counter).padStart(12, "0")}`;
  }

  transport(): SyncTransport {
    return {
      pull: async (kind, after) => {
        const changes = this.changes.filter(
          (change) => change.kind === kind && change.sequence > after,
        );
        return { changes: structuredClone(changes), cursor: this.changes.length };
      },
      push: async (body) => {
        if (this.failNextPush > 0) {
          this.failNextPush -= 1;
          throw new TypeError("Failed to fetch");
        }
        const { operations } = JSON.parse(body) as { operations: Operation[] };
        return { results: operations.map((operation) => this.accept(operation)) };
      },
    };
  }

  accept(operation: Operation): PushResult {
    this.pushes.push(operation);
    const known = this.results.get(operation.operation_id);
    if (known) {
      if (known.ciphertext !== operation.ciphertext)
        throw new ApiError("conflict", "Changed under the same operation id.", 409);
      return known.result;
    }
    const heads = this.heads.get(operation.object_id) ?? new Set<string>();
    const acknowledged = [operation.parent_revision, ...(operation.resolved_revisions ?? [])];
    for (const revision of acknowledged) if (revision) heads.delete(revision);
    const conflict = heads.size > 0;
    const revision = this.revision();
    heads.add(revision);
    this.heads.set(operation.object_id, heads);
    const sequence = this.changes.length + 1;
    this.changes.push({
      sequence,
      operation_id: operation.operation_id,
      object_id: operation.object_id,
      revision,
      parent_revision: operation.parent_revision,
      resolved_revisions: operation.resolved_revisions ?? [],
      kind: operation.kind,
      ciphertext: operation.ciphertext,
      deleted: operation.deleted,
      device_id: "device",
    });
    const result = { operation_id: operation.operation_id, revision, sequence, conflict };
    this.results.set(operation.operation_id, { result, ciphertext: operation.ciphertext });
    return result;
  }
}

export type Script = (body: Record<string, unknown>) => Record<string, unknown>[];

/** An operator whose completions are scripted frames, streamed as SSE. */
export function fakeOperator(
  answer: Script,
  extra: Partial<Record<string, (body: Record<string, unknown>) => Response>> = {},
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const operator: Operator = {
    root: "https://operator.test",
    fetch: async (input, init) => {
      const url = String(input);
      const path = url.slice("https://operator.test".length);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, body });
      if (extra[path]) return (extra[path] as (body: Record<string, unknown>) => Response)(body);
      if (path === "/v1/models")
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (path === "/v1/chat/completions") {
        const frames = answer(body)
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join("");
        return new Response(`${frames}data: [DONE]\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("{}", { status: 404 });
    },
  };
  return { operator, calls };
}

export const text = (content: string) => [
  { choices: [{ delta: { content } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];
export const toolCall = (name: string, args: Record<string, unknown>, id = "call_1") => [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];
