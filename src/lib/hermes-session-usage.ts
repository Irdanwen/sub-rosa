/**
 * Normalized session usage — the typed shape feature 09's usage/context/cost
 * panel renders, parsed defensively from the raw `session.usage` result.
 *
 * The gateway's `methods.getSessionUsage(...)` resolves to `unknown`: Hermes can
 * add, rename, or drop usage fields between pins, and providers report tokens
 * under different keys. So this module owns the ONE place that turns that raw
 * blob into {@link SessionUsage}. Every field is optional and stays `undefined`
 * when absent or malformed; the parser tolerates both snake_case and camelCase
 * and never throws on junk. The UI degrades each missing field to "Unavailable"
 * rather than guessing.
 *
 * Reusable by feature 11 (activity drawer): the drawer can call the same parser
 * and render {@link import("../components/agent/SessionUsagePanel").SessionUsagePanel}
 * as a tab.
 */

import { asRecord, pickNumber, pickString } from "./hermes-control-plane";

/** A single tool or subagent cost line, when the gateway breaks costs down. */
export type SessionToolCost = {
  name: string;
  estimatedCostUsd?: number;
};

/** Normalized, UI-ready usage for one session. All metrics optional: a field is
 * present only when the gateway reported a usable value. */
export type SessionUsage = {
  sessionId: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  contextUsed?: number;
  contextLimit?: number;
  estimatedCostUsd?: number;
  /** API calls the live agent has made in this session. The one field that
   * says whether the counters beside it describe any work at all. */
  apiCalls?: number;
  /** Per-tool / per-subagent cost breakdown, when returned. */
  toolCosts?: SessionToolCost[];
  /** The untouched gateway result, kept for the trace panel / debugging. */
  raw?: unknown;
};

/**
 * Whether this reading describes any work.
 *
 * The runtime keeps a session's counters in memory on its agent, and builds a
 * fresh agent every time it loads a session it had dropped. So the counters
 * restart at zero on every reload, and the runtime never says so: it answers
 * `session.usage` with `{"calls": 0, "input": 0, "output": 0, "total": 0}` when
 * the agent is gone, and with the model plus the same zeros when the agent is
 * new (`tui_gateway/server.py`, `_get_usage`). Both used to pass as readings
 * and overwrite counters the panel had been showing a minute earlier, which is
 * what "the numbers vanish after a while" was.
 *
 * `calls` is the field that settles it: an agent that has made no API call has
 * counted nothing, whatever else it reports about itself. Older or unknown
 * shapes that omit `calls` fall back to "any counter above zero", which reaches
 * the same verdict without it.
 */
export function hasAnyReading(usage: SessionUsage): boolean {
  if (usage.apiCalls !== undefined) return usage.apiCalls > 0;
  return (
    positive(usage.promptTokens) ||
    positive(usage.completionTokens) ||
    positive(usage.totalTokens) ||
    positive(usage.contextUsed) ||
    positive(usage.estimatedCostUsd)
  );
}

/** A counter that counted something. Zero is not a reading here: it is what
 * every field of a reloaded session reports. */
function positive(value?: number): boolean {
  return value !== undefined && value > 0;
}

/** A reading and the moment it was taken. */
export type DatedReading = { usage: SessionUsage; readAt: number };

/**
 * The last reading that counted something, per session, for this run of the
 * app.
 *
 * Refusing to overwrite counters with a reloaded session's zeros only holds
 * while the panel stays open: its state dies with it, so closing and reopening
 * used to lose the reading all over again. The runtime cannot help here, since
 * the number is gone from the runtime too. Somebody has to remember it, and
 * the honest scope for that memory is this process: it is not persisted, and
 * nothing pretends it survives a relaunch.
 */
const readings = new Map<string, DatedReading>();

/** Enough sessions for any run, and a ceiling so a long-lived window cannot
 * accumulate readings forever. Oldest inserted goes first. */
const MAX_REMEMBERED = 64;

/** Files a reading that counted something. Callers check {@link hasAnyReading}
 * first; this stores whatever it is given. */
export function rememberReading(usage: SessionUsage, readAt: number): void {
  readings.delete(usage.sessionId);
  readings.set(usage.sessionId, { usage, readAt });
  while (readings.size > MAX_REMEMBERED) {
    const oldest = readings.keys().next();
    if (oldest.done) break;
    readings.delete(oldest.value);
  }
}

/** The last reading that counted something for this session, if one was taken
 * since the app started. */
export function lastReading(sessionId: string): DatedReading | undefined {
  return readings.get(sessionId);
}

/** Test seam. Nothing in the app clears these: a reading stays until the
 * process ends or the ceiling evicts it. */
export function forgetReadings(): void {
  readings.clear();
}

/**
 * The same reading with its counters removed.
 *
 * What the runtime reports about a session it has just reloaded is a model and
 * a row of zeros. The model is true and worth showing; the zeros are not a
 * count of anything, and rendering them as "0" states that the session spent
 * nothing. Stripped, each counter renders as "Unavailable", which is what is
 * actually known.
 */
export function withoutCounters(usage: SessionUsage): SessionUsage {
  return {
    sessionId: usage.sessionId,
    provider: usage.provider,
    model: usage.model,
    raw: usage.raw,
  };
}

function parseToolCosts(value: unknown): SessionToolCost[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const costs: SessionToolCost[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = pickString([record], ["name", "tool", "tool_name", "label"]) ?? undefined;
    if (!name) continue;
    costs.push({
      name,
      estimatedCostUsd: pickNumber(
        [record],
        ["estimated_cost_usd", "estimatedCostUsd", "cost_usd", "costUsd"],
      ),
    });
  }
  return costs.length > 0 ? costs : undefined;
}

/**
 * Parse a raw `session.usage` result into a {@link SessionUsage}. Defensive by
 * design: unknown shape in, normalized shape out, missing/malformed fields left
 * `undefined`. `sessionId` is always carried through from the caller so the
 * panel can label which session it describes even when the payload omits it.
 */
export function parseSessionUsage(sessionId: string, raw: unknown): SessionUsage {
  const root = asRecord(raw);
  // Tokens may live at the root or under a `usage` / `tokens` sub-object.
  const usage = asRecord(root?.usage) ?? asRecord(root?.tokens);
  // Context may live at the root or under a `context` sub-object.
  const context = asRecord(root?.context);

  const tokenContainers = [usage, root];
  const contextContainers = [context, root];

  return {
    sessionId,
    provider: pickString([root], ["provider", "provider_name", "vendor"]),
    model: pickString([root], ["model", "model_name", "model_id", "modelId"]),
    // Each list ends with Hermes's own `SessionUsageResponse` names
    // (input/output/total, context_used/context_max) so the live gateway's
    // shape is read directly, not just the generic OpenAI-style aliases.
    promptTokens: pickNumber(tokenContainers, [
      "prompt_tokens",
      "promptTokens",
      "input_tokens",
      "inputTokens",
      "input",
    ]),
    completionTokens: pickNumber(tokenContainers, [
      "completion_tokens",
      "completionTokens",
      "output_tokens",
      "outputTokens",
      "output",
    ]),
    totalTokens: pickNumber(tokenContainers, ["total_tokens", "totalTokens", "total"]),
    contextUsed: pickNumber(contextContainers, [
      "used",
      "context_used",
      "contextUsed",
      "used_tokens",
    ]),
    contextLimit: pickNumber(contextContainers, [
      "limit",
      "context_limit",
      "contextLimit",
      "context_max",
      "max_tokens",
      "maxTokens",
      "window",
    ]),
    estimatedCostUsd: pickNumber(
      [root],
      ["estimated_cost_usd", "estimatedCostUsd", "cost_usd", "costUsd"],
    ),
    apiCalls: pickNumber(tokenContainers, ["calls", "api_calls", "apiCalls", "requests"]),
    toolCosts: parseToolCosts(root?.tool_costs ?? root?.toolCosts ?? root?.tools),
    raw,
  };
}
