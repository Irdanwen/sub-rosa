/**
 * The code event contract (ADR-0123), the TypeScript side.
 *
 * One neutral model of what a run of code work does, whatever engine runs it
 * (Hermes through its gateway, Claude Code and opencode through ACP later).
 * The Rust side (`src-tauri/src/code/event.rs`) is the reference: it writes
 * `fixtures/code-events.v1.json`, and `src/test/code-events.test.ts` reads it
 * back through {@link parseCodeEventLine}, so the two cannot drift apart
 * silently.
 *
 * Wire names are snake_case, as in the JSON lines `subrosa-code run` writes.
 * A consumer skips a `type` it does not know: a new event type is additive
 * within a schema version.
 */

export const CODE_EVENT_SCHEMA_VERSION = 1;

/** Every `type` of schema 1, in the order the Rust contract lists them. */
export const CODE_EVENT_TYPES = [
  "run.started",
  "run.finished",
  "turn.started",
  "turn.finished",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "terminal.output",
  "approval.requested",
  "approval.resolved",
  "todo.updated",
  "step.recorded",
  "usage",
  "error",
] as const;

export type CodeEventType = (typeof CODE_EVENT_TYPES)[number];

export type Engine = "hermes" | "claude_code" | "opencode";
export type RunMode = "build" | "plan";
export type RunStatus = "completed" | "failed" | "budget_exceeded" | "interrupted";
export type TurnStatus = "completed" | "failed" | "interrupted";
export type MessageChannel = "answer" | "reasoning";
export type ToolKind = "read" | "edit" | "shell" | "search" | "delegate" | "other";
export type ApprovalKind = "command" | "clarify" | "sudo" | "secret";
export type ApprovalDecision = "once" | "session" | "always" | "deny" | "answered";
export type Resolver = "user" | "policy";
export type DiagnosticSeverity = "error" | "warning" | "info";
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** Lines of a file, 1-based and inclusive. */
export type LineRange = { start: number; end: number };

export type Diagnostic = {
  severity: DiagnosticSeverity;
  message: string;
  line?: number;
  source?: string;
};

/** What a modification did and what checked it. */
export type EditDetail = {
  /** How the old text was found; Hermes v0.19 does not report it yet. */
  strategy?: string;
  formatter?: string;
  diagnostics?: Diagnostic[];
  added: number;
  removed: number;
  /** Unified diff, when the engine gave one. */
  diff?: string;
  /** Every file the call changed, when it changed more than `path`. */
  files?: string[];
};

/** What a tool call touched, as far as the engine said. */
export type ToolDetail = {
  path?: string;
  lines?: LineRange;
  command?: string;
  query?: string;
  edit?: EditDetail;
};

export type TodoItem = { id?: string; content: string; status: TodoStatus };

export type CodeEvent =
  | {
      type: "run.started";
      engine: Engine;
      model: string;
      mode: RunMode;
      dir: string;
      budget_usd?: number;
      /** Spent by earlier invocations of the same run. */
      spent_usd?: number;
      resumed: boolean;
      sandboxed: boolean;
      session_id?: string;
    }
  | {
      type: "run.finished";
      status: RunStatus;
      reason?: string;
      cost_usd?: number;
      turns: number;
    }
  | { type: "turn.started"; turn_id: string }
  | { type: "turn.finished"; turn_id: string; status: TurnStatus }
  | { type: "message.delta"; message_id?: string; channel: MessageChannel; text: string }
  | { type: "message.completed"; message_id?: string; text: string; interim: boolean }
  | {
      type: "tool.started";
      call_id: string;
      name: string;
      kind: ToolKind;
      /** The engine's own one-line description, for display only. */
      label?: string;
      detail?: ToolDetail;
    }
  | { type: "tool.progress"; call_id: string; text: string }
  | {
      type: "tool.completed";
      call_id: string;
      name: string;
      kind: ToolKind;
      ok: boolean;
      detail?: ToolDetail;
      summary?: string;
      error?: string;
      duration_ms?: number;
    }
  | {
      type: "terminal.output";
      call_id?: string;
      text: string;
      exit_code?: number;
      truncated: boolean;
    }
  | {
      type: "approval.requested";
      request_id: string;
      kind: ApprovalKind;
      command?: string;
      description?: string;
      choices?: string[];
    }
  | {
      type: "approval.resolved";
      request_id: string;
      decision: ApprovalDecision;
      by: Resolver;
    }
  | { type: "todo.updated"; items: TodoItem[] }
  /** Reserved for the step timeline (P1); no adapter emits it yet. */
  | { type: "step.recorded"; step_id: string; call_id?: string; files: string[] }
  | {
      type: "usage";
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cost_usd?: number;
      budget_usd?: number;
    }
  | { type: "error"; message: string; code?: string; recoverable: boolean };

/** One line of a run's event stream. */
export type CodeEventLine = CodeEvent & {
  schema: number;
  run_id: string;
  /** Position in the run, from 1, continued across resumed invocations. */
  seq: number;
  /** RFC 3339, UTC. */
  at: string;
};

type Field = "string" | "number" | "boolean" | "object" | "array";
type Shape = Record<string, { type: Field; optional?: boolean; oneOf?: readonly string[] }>;

const ENGINES = ["hermes", "claude_code", "opencode"] as const;
const RUN_MODES = ["build", "plan"] as const;
const RUN_STATUSES = ["completed", "failed", "budget_exceeded", "interrupted"] as const;
const TURN_STATUSES = ["completed", "failed", "interrupted"] as const;
const TOOL_KINDS = ["read", "edit", "shell", "search", "delegate", "other"] as const;

const req = (type: Field, oneOf?: readonly string[]) => ({ type, oneOf });
const opt = (type: Field) => ({ type, optional: true });

/** The fields each type requires, and their JSON types. Nested objects are
 * checked by {@link checkDetail}. */
const SHAPES: Record<CodeEventType, Shape> = {
  "run.started": {
    engine: req("string", ENGINES),
    model: req("string"),
    mode: req("string", RUN_MODES),
    dir: req("string"),
    budget_usd: opt("number"),
    spent_usd: opt("number"),
    resumed: req("boolean"),
    sandboxed: req("boolean"),
    session_id: opt("string"),
  },
  "run.finished": {
    status: req("string", RUN_STATUSES),
    reason: opt("string"),
    cost_usd: opt("number"),
    turns: req("number"),
  },
  "turn.started": { turn_id: req("string") },
  "turn.finished": { turn_id: req("string"), status: req("string", TURN_STATUSES) },
  "message.delta": {
    message_id: opt("string"),
    channel: req("string", ["answer", "reasoning"]),
    text: req("string"),
  },
  "message.completed": { message_id: opt("string"), text: req("string"), interim: req("boolean") },
  "tool.started": {
    call_id: req("string"),
    name: req("string"),
    kind: req("string", TOOL_KINDS),
    label: opt("string"),
    detail: opt("object"),
  },
  "tool.progress": { call_id: req("string"), text: req("string") },
  "tool.completed": {
    call_id: req("string"),
    name: req("string"),
    kind: req("string", TOOL_KINDS),
    ok: req("boolean"),
    detail: opt("object"),
    summary: opt("string"),
    error: opt("string"),
    duration_ms: opt("number"),
  },
  "terminal.output": {
    call_id: opt("string"),
    text: req("string"),
    exit_code: opt("number"),
    truncated: req("boolean"),
  },
  "approval.requested": {
    request_id: req("string"),
    kind: req("string", ["command", "clarify", "sudo", "secret"]),
    command: opt("string"),
    description: opt("string"),
    choices: opt("array"),
  },
  "approval.resolved": {
    request_id: req("string"),
    decision: req("string", ["once", "session", "always", "deny", "answered"]),
    by: req("string", ["user", "policy"]),
  },
  "todo.updated": { items: req("array") },
  "step.recorded": { step_id: req("string"), call_id: opt("string"), files: req("array") },
  usage: {
    input_tokens: req("number"),
    output_tokens: req("number"),
    cached_tokens: req("number"),
    cost_usd: opt("number"),
    budget_usd: opt("number"),
  },
  error: { message: req("string"), code: opt("string"), recoverable: req("boolean") },
};

const ENVELOPE: Shape = {
  schema: req("number"),
  run_id: req("string"),
  seq: req("number"),
  at: req("string"),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldMatches(value: unknown, type: Field): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function matchesShape(value: Record<string, unknown>, shape: Shape): boolean {
  return Object.entries(shape).every(([key, rule]) => {
    const field = value[key];
    if (field === undefined) return rule.optional === true;
    if (!fieldMatches(field, rule.type)) return false;
    return !rule.oneOf || rule.oneOf.includes(field as string);
  });
}

function checkDetail(detail: unknown): boolean {
  if (detail === undefined) return true;
  if (!isRecord(detail)) return false;
  const ok = matchesShape(detail, {
    path: opt("string"),
    lines: opt("object"),
    command: opt("string"),
    query: opt("string"),
    edit: opt("object"),
  });
  if (!ok) return false;
  if (
    detail.lines !== undefined &&
    !matchesShape(detail.lines as Record<string, unknown>, {
      start: req("number"),
      end: req("number"),
    })
  )
    return false;
  if (detail.edit === undefined) return true;
  const edit = detail.edit as Record<string, unknown>;
  return (
    matchesShape(edit, {
      strategy: opt("string"),
      formatter: opt("string"),
      diagnostics: opt("array"),
      added: req("number"),
      removed: req("number"),
      diff: opt("string"),
      files: opt("array"),
    }) &&
    ((edit.diagnostics as unknown[] | undefined) ?? []).every(
      (item) =>
        isRecord(item) &&
        matchesShape(item, {
          severity: req("string", ["error", "warning", "info"]),
          message: req("string"),
          line: opt("number"),
          source: opt("string"),
        }),
    )
  );
}

function checkTodos(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.every(
      (item) =>
        isRecord(item) &&
        matchesShape(item, {
          id: opt("string"),
          content: req("string"),
          status: req("string", ["pending", "in_progress", "completed", "cancelled"]),
        }),
    )
  );
}

export function isCodeEventType(value: unknown): value is CodeEventType {
  return typeof value === "string" && (CODE_EVENT_TYPES as readonly string[]).includes(value);
}

/** The event, when `value` is one this schema knows; `null` otherwise (an
 * unknown type included, which a consumer skips). */
export function parseCodeEvent(value: unknown): CodeEvent | null {
  if (!isRecord(value) || !isCodeEventType(value.type)) return null;
  if (!matchesShape(value, SHAPES[value.type])) return null;
  if (!checkDetail(value.detail)) return null;
  if (value.type === "todo.updated" && !checkTodos(value.items)) return null;
  return value as CodeEvent;
}

/** A whole line: the envelope at this schema version, and a known event. */
export function parseCodeEventLine(value: unknown): CodeEventLine | null {
  if (!isRecord(value) || !matchesShape(value, ENVELOPE)) return null;
  if (value.schema !== CODE_EVENT_SCHEMA_VERSION) return null;
  return parseCodeEvent(value) ? (value as CodeEventLine) : null;
}
