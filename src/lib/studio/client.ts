// Studio media client: a thin, typed wrapper over the Rust media proxy
// (`carpe_diem_media_request`). The API key never reaches the webview — the
// proxy reads it from the OS keychain and forwards the call to the backend.
//
// Retry policy mirrors the backends' semantics: transient statuses (408, 425,
// 429, 5xx) retry with exponential backoff + jitter, honoring Retry-After;
// client errors surface immediately with the backend's own message.

import { invoke } from "@tauri-apps/api/core";
import type { MediaProxyResponse } from "./types";

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 750;
const MAX_RETRY_AFTER_MS = 30_000;

export class MediaError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;

  constructor(message: string, options: { status: number; code?: string; retryAfterMs?: number }) {
    super(message);
    this.name = "MediaError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** A sync media call the backend wants run through its async queue instead:
 * the edge cap 502s, or the backend rejects the model upfront with
 * `409 MODEL_REQUIRES_ASYNC` / a "use the queue" message. */
export function isAsyncRetrySignal(error: unknown): boolean {
  return (
    error instanceof MediaError &&
    (error.status === 502 ||
      error.status === 409 ||
      error.code === "MODEL_REQUIRES_ASYNC" ||
      /queue|synchronous|async/i.test(error.message))
  );
}

interface MediaCall {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("The media request was cancelled.", "AbortError");
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("The media request was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Human-readable message from a backend error body ({error, code} on Carpe
 * Diem, {error: {message}} or {message} elsewhere). */
function errorMessage(json: unknown, status: number): { message: string; code?: string } {
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    if (typeof record.error === "string") return { message: record.error, code };
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string") return { message: nested.message, code };
    }
    if (typeof record.message === "string") return { message: record.message, code };
  }
  return { message: `The media backend returned status ${status}.` };
}

async function sendOnce(call: MediaCall): Promise<MediaProxyResponse> {
  throwIfAborted(call.signal);
  return invoke<MediaProxyResponse>("carpe_diem_media_request", {
    request: { method: call.method, path: call.path, body: call.body },
  });
}

async function send(call: MediaCall): Promise<MediaProxyResponse> {
  let lastError: MediaError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await sendOnce(call);
    if (response.ok) return response;
    const { message, code } = errorMessage(response.json, response.status);
    const error = new MediaError(message, {
      status: response.status,
      code,
      retryAfterMs: response.retryAfterMs,
    });
    if (!RETRY_STATUSES.has(response.status) || attempt === MAX_RETRIES) {
      throw error;
    }
    lastError = error;
    const backoff = BASE_BACKOFF_MS * 2 ** attempt;
    const jitter = backoff * (Math.random() * 0.5 - 0.25);
    const delay = Math.min(
      response.retryAfterMs ?? Math.round(backoff + jitter),
      MAX_RETRY_AFTER_MS,
    );
    await sleep(delay, call.signal);
  }
  // Unreachable: the loop either returns or throws, but keep TypeScript sure.
  throw lastError ?? new MediaError("The media request failed.", { status: 0 });
}

/** JSON-in, JSON-out call (generate, queue, retrieve, quote...). */
export async function mediaJson<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await send({ method: "POST", path, body, signal });
  return response.json as T;
}

export async function mediaGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await send({ method: "GET", path, signal });
  return response.json as T;
}

/** Raw proxy response, for endpoints whose success shape depends on job
 * state (the async image retrieve returns JSON while pending and binary once
 * done). Retries still apply; interpreting the body is the caller's job. */
export async function mediaRaw(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<MediaProxyResponse> {
  return send({ method: "POST", path, body, signal });
}

/** Binary-out call (TTS speech, image edit/upscale bytes). */
export async function mediaBinary(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ base64: string; contentType?: string }> {
  const response = await send({ method: "POST", path, body, signal });
  if (!response.bodyBase64) {
    // Some backends wrap binary results in JSON ({images: [b64]}); callers
    // that expect that shape use mediaJson instead. Reaching this branch
    // means the response shape changed.
    throw new MediaError("The backend did not return a file.", {
      status: response.status,
    });
  }
  return { base64: response.bodyBase64, contentType: response.contentType };
}
