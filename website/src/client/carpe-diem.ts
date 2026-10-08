/**
 * Carpe Diem, called from the browser with the browser device's bounded key
 * (ADR-0096). Only the routes a browser key may reach: chat completions, web
 * augmentation, speech and the public model list. The site's CSP names this
 * origin and nothing else beyond its own.
 */
import { CARPE_DIEM_OPERATOR } from "../lib/browser-device";

export class CarpeDiemError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}
/** A part of a multimodal user message: text, or a picture as a data URL. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** The operator, overridable for tests and a local operator in development. */
export interface Operator {
  root: string;
  fetch: typeof fetch;
}
export const defaultOperator = (): Operator => ({
  root: CARPE_DIEM_OPERATOR,
  fetch: (...args) => fetch(...args),
});

/** The operator's refusal, as an error that keeps its code and status. */
export async function failure(response: Response): Promise<CarpeDiemError> {
  let code = "carpe_diem_unavailable";
  let message = `Carpe Diem answered ${response.status}.`;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.code === "string") code = body.code;
    const error = body.error;
    if (typeof error === "string") message = error;
    else if (
      error &&
      typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
    )
      message = (error as { message: string }).message;
    else if (typeof body.message === "string") message = body.message;
  } catch {
    // Not JSON: the status says enough.
  }
  return new CarpeDiemError(code, response.status, message);
}

/** A JSON `POST` with the browser's key: no cookie, no redirect, no referrer. */
export function request(key: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  };
}

/** One streamed frame of a completion, folded into the reply so far. */
export function applyFrame(reply: Completion, frame: Record<string, unknown>) {
  const choice = (frame.choices as Record<string, unknown>[] | undefined)?.[0];
  if (!choice) return;
  const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
  if (typeof delta.content === "string") reply.content += delta.content;
  const calls = delta.tool_calls as Record<string, unknown>[] | undefined;
  for (const [position, call] of (calls ?? []).entries()) {
    const index = typeof call.index === "number" ? call.index : position;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    if (!reply.toolCalls[index])
      reply.toolCalls[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
    const current = reply.toolCalls[index];
    if (typeof call.id === "string" && call.id) current.id = call.id;
    if (typeof fn.name === "string") current.function.name += fn.name;
    if (typeof fn.arguments === "string") current.function.arguments += fn.arguments;
  }
  if (typeof choice.finish_reason === "string") reply.finishReason = choice.finish_reason;
}

/**
 * A chat completion, streamed: `onText` gets each fragment of the reply as
 * it arrives. A stream that ends before the completion says it finished,
 * holding part of a reply, is an error rather than a short answer.
 */
export async function streamCompletion(
  operator: Operator,
  key: string,
  body: Record<string, unknown>,
  onText: (fragment: string) => void,
  signal?: AbortSignal,
): Promise<Completion> {
  const response = await operator.fetch(
    `${operator.root}/v1/chat/completions`,
    request(key, { ...body, stream: true }, signal),
  );
  if (!response.ok) throw await failure(response);
  const reply: Completion = { content: "", toolCalls: [], finishReason: null };
  if (!response.headers.get("content-type")?.includes("event-stream")) {
    // A route that answers in one piece.
    const value = (await response.json()) as Record<string, unknown>;
    applyFrame(reply, value);
    if (reply.content) onText(reply.content);
    return finish(reply);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CarpeDiemError("empty_stream", 502, "The reply was empty.");
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const line = (raw: string) => {
    const text = raw.trim();
    if (!text.startsWith("data:")) return;
    const data = text.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      return;
    }
    try {
      const before = reply.content.length;
      applyFrame(reply, JSON.parse(data) as Record<string, unknown>);
      if (reply.content.length > before) onText(reply.content.slice(before));
    } catch {
      // A malformed frame is skipped, the next one still counts.
    }
  };
  while (true) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) line(raw);
  }
  buffer += decoder.decode();
  if (buffer) line(buffer);
  if (!done && !reply.finishReason && (reply.content || reply.toolCalls.length))
    throw new CarpeDiemError("reply_cut_off", 502, "The reply was cut off.");
  return finish(reply);
}

function finish(reply: Completion): Completion {
  reply.toolCalls = reply.toolCalls.filter(Boolean).map((call, index) => ({
    ...call,
    id: call.id || `call_${index}`,
  }));
  return reply;
}

export interface WebResult {
  title: string;
  url: string;
  snippet?: string;
  date?: string;
}

/** `/v1/augment/search`, the same Venice augment the app's sidecar calls. */
export async function webSearch(
  operator: Operator,
  key: string,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<WebResult[]> {
  const response = await operator.fetch(
    `${operator.root}/v1/augment/search`,
    request(key, { query, limit, search_provider: "brave" }, signal),
  );
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { results?: Record<string, unknown>[] };
  return (body.results ?? [])
    .filter((result) => typeof result.url === "string" && result.url.trim())
    .map((result) => ({
      title: (typeof result.title === "string" && result.title.trim()) || String(result.url),
      url: String(result.url),
      snippet: typeof result.content === "string" ? result.content : undefined,
      date: typeof result.date === "string" ? result.date : undefined,
    }));
}

/** `/v1/augment/scrape`: one page's text. */
export async function fetchPage(
  operator: Operator,
  key: string,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await operator.fetch(
    `${operator.root}/v1/augment/scrape`,
    request(key, { url }, signal),
  );
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { content?: unknown };
  return typeof body.content === "string" ? body.content : "";
}

/** `/v1/audio/speech`: the audio of a short text, as bytes. */
export async function speech(
  operator: Operator,
  key: string,
  input: string,
  voice: { model: string; voice?: string },
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await operator.fetch(
    `${operator.root}/v1/audio/speech`,
    request(
      key,
      {
        model: voice.model,
        input,
        response_format: "mp3",
        ...(voice.voice ? { voice: voice.voice } : {}),
      },
      signal,
    ),
  );
  if (!response.ok) throw await failure(response);
  return response.arrayBuffer();
}

export interface LiveModel {
  id: string;
  type: string;
  contextTokens?: number;
  supportsReasoningEffort?: boolean;
  supportsVision?: boolean;
  voices?: string[];
}

/** The public catalog. No key: it is the same list anyone can read. */
export async function liveModels(operator: Operator, signal?: AbortSignal): Promise<LiveModel[]> {
  const response = await operator.fetch(`${operator.root}/v1/models`, {
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { data?: Record<string, unknown>[] };
  return (body.data ?? []).map((row) => {
    const capabilities = (row.capabilities ?? {}) as Record<string, unknown>;
    const flag = (name: string) =>
      Object.entries(capabilities).some(
        ([key, value]) => value === true && key.toLowerCase().replace(/[^a-z]/g, "") === name,
      );
    return {
      id: String(row.id),
      type: String(row.carpe_diem_type ?? ""),
      contextTokens: typeof row.context_length === "number" ? row.context_length : undefined,
      supportsReasoningEffort: flag("supportsreasoningeffort"),
      supportsVision: flag("supportsvision"),
      voices: Array.isArray(row.voices) ? row.voices.map(String) : undefined,
    };
  });
}
