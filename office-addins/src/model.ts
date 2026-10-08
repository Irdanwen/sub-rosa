/**
 * The panes' two ways of asking a model, both the web client's own code
 * (ADR-0102): a single completion for a rewrite or a formula, as the canvas
 * rewrite does it (`carpe-diem.ts::streamCompletion`), and the agent-lite turn
 * (`agent.ts::runTurn`) when tools may help: the web search for a draft,
 * Python for a range, `make_document` for slides.
 */
import { DEFAULT_PERSONALIZATION, runTurn } from "../../website/src/client/agent";
import {
  type ChatMessage,
  defaultOperator,
  type Operator,
  streamCompletion,
} from "../../website/src/client/carpe-diem";
import { AGENT_LITE } from "../../website/src/client/codec";
import type { TurnAddition } from "../../website/src/client/feature";
import type { SyncClient } from "../../website/src/client/sync";
import { fill, OFFICE, type RewriteKind } from "./words";

export interface Engine {
  operator: Operator;
  model: string;
  openKey(): Promise<string | null>;
}

export function engine(openKey: () => Promise<string | null>): Engine {
  return { operator: defaultOperator(), model: AGENT_LITE.defaultModel, openKey };
}

export class PaneError extends Error {
  constructor(public code: "no_key" | "too_long" | "empty" | "no_answer") {
    super(code);
  }
}

async function keyOf(engine: Engine): Promise<string> {
  const key = await engine.openKey();
  if (!key) throw new PaneError("no_key");
  return key;
}

export interface AskOptions {
  signal?: AbortSignal;
  onText?: (fragment: string) => void;
}

/** One completion: a system prompt, one message, the reply's text. */
export async function complete(
  engine: Engine,
  system: string,
  message: string,
  options: AskOptions & { temperature?: number } = {},
): Promise<string> {
  const key = await keyOf(engine);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: message },
  ];
  const body: Record<string, unknown> = { model: engine.model, messages };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  const reply = await streamCompletion(
    engine.operator,
    key,
    body,
    options.onText ?? (() => undefined),
    options.signal,
  );
  const text = reply.content.trim();
  if (!text) throw new PaneError("no_answer");
  return text;
}

/** The note editor's rewrite of a passage, from Rust's words. */
export function rewrite(
  engine: Engine,
  kind: RewriteKind,
  text: string,
  values: { language?: string; instruction?: string } = {},
  options: AskOptions = {},
): Promise<string> {
  if (!text.trim()) return Promise.reject(new PaneError("empty"));
  if (Array.from(text).length > OFFICE.rewrite.maxChars)
    return Promise.reject(new PaneError("too_long"));
  const message = fill(OFFICE.rewrite.messages[kind], {
    text,
    language: values.language ?? "English",
    instruction: values.instruction?.trim() ?? "",
  });
  return complete(engine, OFFICE.rewrite.system, message, {
    ...options,
    temperature: OFFICE.rewrite.temperature,
  });
}

/** The pane reads nothing of the account: no notes, no memory, no history.
 * `allowTool` keeps every tool that would reach it out of the turn, so the
 * loop never touches this. */
const NO_ACCOUNT = {} as SyncClient;

/** Tools that never read the account. */
const WEB_TOOLS = ["web_search", "fetch_page"];

/**
 * One agent-lite turn: the shared prompt, the pane's words and tools, the web
 * search, nothing of the person's notes or memory (the pane does not unlock
 * the vault).
 */
export async function officeTurn(
  engine: Engine,
  question: string,
  additions: TurnAddition[],
  options: AskOptions & { onStatus?: (stage: string, detail?: string) => void } = {},
): Promise<string> {
  const key = await keyOf(engine);
  const own = new Set([
    ...WEB_TOOLS,
    ...additions.flatMap((addition) => addition.tools.map((tool) => tool.function.name)),
  ]);
  const result = await runTurn(
    {
      sync: NO_ACCOUNT,
      operator: engine.operator,
      key,
      model: engine.model,
      memory: false,
      personalization: { ...DEFAULT_PERSONALIZATION, enabled: false },
      temporary: true,
      signal: options.signal,
      onText: options.onText ?? (() => undefined),
      onStatus: options.onStatus,
      additions,
      allowTool: (name) => own.has(name),
      question,
    },
    [
      {
        id: "office",
        taskId: "office",
        role: "user",
        content: question,
        createdAt: new Date().toISOString(),
      },
    ],
  );
  return result.answer.trim();
}
