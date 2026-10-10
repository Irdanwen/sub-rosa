/**
 * The session courier (ADR-0102 and its addendum of 2026-10-10).
 *
 * The Office task panes live on an origin of their own
 * (`office.subrosa.furetier.com`), because Office.js, Microsoft's script that
 * cannot be pinned, runs in them. The account's cookie is host-only, so it
 * never reaches that origin, and in Office on the web the pane is moreover a
 * frame on Microsoft's site. The pane still holds its own device key and its
 * own Carpe Diem key; what it lacks is the signed-in session a few device
 * calls need (admission, the key's assertion, renouncing).
 *
 * The sign-in window (`/office/session.html` on the office origin, opened
 * with Office's dialog API) embeds the account origin's
 * `/office/courier.html`, a page with no Office.js. The two are the same
 * site, so the account's `SameSite=Lax` cookie reaches that frame, which
 * carries the pane's calls, and only those:
 *
 *   pane --messageChild--> window --postMessage--> courier frame --fetch--> service
 *
 * - the pane signs every device proof itself, single-use and bound to the
 *   exact URL; the frame adds the cookie and the CSRF token, nothing else;
 * - what crosses Office's channel is proofs, a pairing code's request id, an
 *   assertion bound to a key that never leaves the pane, and the service's
 *   answers: nothing that spends;
 * - a recovery key's admission proof is refused, because the channel runs
 *   through Office: a pane is admitted only by the app's approval.
 *
 * This file is the protocol and both ends of it; `website/src/office/` runs
 * the frame, `office-addins/src/session/relay.ts` the window between.
 */

/** The calls the courier carries, and no other. */
const ROUTES: [string, RegExp][] = [
  ["GET", /^\/api\/v1\/me$/],
  ["GET", /^\/api\/v1\/devices$/],
  ["POST", /^\/api\/v1\/pairing$/],
  ["GET", /^\/api\/v1\/pairing\/[0-9a-f-]{36}$/],
  ["POST", /^\/api\/v1\/browser-devices$/],
  ["POST", /^\/api\/v1\/browser-devices\/renounce$/],
  ["POST", /^\/api\/v1\/carpe-diem\/assertion$/],
];
/** The request headers the pane may set; the courier frame sets the rest. */
const FORWARDED = ["subrosa-device-proof", "x-subrosa-account-id"];
const MAX_BODY = 64 * 1024;
const MAX_ANSWER = 512 * 1024;
const TIMEOUT_MS = 30_000;

export interface CourierRequest {
  v: 1;
  type: "request";
  id: string;
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  body?: string;
}
/** The window asks the frame who is signed in; the frame answers with
 * `ready` or `signed-out`. */
export interface CourierHello {
  v: 1;
  type: "hello";
}
export type CourierMessage =
  | { v: 1; type: "ready"; account: { id: string; email: string } }
  | { v: 1; type: "signed-out" }
  | { v: 1; type: "response"; id: string; status: number; body: string };

export function carried(method: string, path: string): boolean {
  return ROUTES.some(([verb, pattern]) => verb === method && pattern.test(path));
}

/** A message from the other side, or null when it is not one of ours. */
export function parseMessage(raw: unknown): CourierMessage | CourierRequest | CourierHello | null {
  if (typeof raw !== "string" || raw.length > MAX_ANSWER + 4096) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.v !== 1) return null;
  switch (message.type) {
    case "ready": {
      const account = message.account as Record<string, unknown> | undefined;
      return typeof account?.id === "string" && typeof account.email === "string"
        ? { v: 1, type: "ready", account: { id: account.id, email: account.email } }
        : null;
    }
    case "signed-out":
      return { v: 1, type: "signed-out" };
    case "hello":
      return { v: 1, type: "hello" };
    case "response":
      return typeof message.id === "string" &&
        Number.isInteger(message.status) &&
        typeof message.body === "string"
        ? {
            v: 1,
            type: "response",
            id: message.id,
            status: message.status as number,
            body: message.body,
          }
        : null;
    case "request": {
      const headers = message.headers;
      if (
        typeof message.id !== "string" ||
        message.id.length > 64 ||
        (message.method !== "GET" && message.method !== "POST") ||
        typeof message.path !== "string" ||
        !headers ||
        typeof headers !== "object" ||
        (message.body !== undefined && typeof message.body !== "string")
      )
        return null;
      const kept: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers as Record<string, unknown>))
        if (FORWARDED.includes(name.toLowerCase()) && typeof value === "string")
          kept[name.toLowerCase()] = value;
      return {
        v: 1,
        type: "request",
        id: message.id,
        method: message.method,
        path: message.path,
        headers: kept,
        body: message.body as string | undefined,
      };
    }
    default:
      return null;
  }
}

const refusal = (code: string) => JSON.stringify({ error: { code } });

// ── The pane's side ────────────────────────────────────────────────────────

/**
 * An `ApiTransport` (`website/src/lib/api.ts`) that sends each call through
 * `send` and resolves when the window answers. `receive` takes what the
 * window posts back.
 */
export function courierTransport(send: (message: string) => void, timeoutMs = TIMEOUT_MS) {
  const waiting = new Map<string, (answer: { status: number; body: string }) => void>();
  const transport = (path: string, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    if ((method !== "GET" && method !== "POST") || !carried(method, path))
      return Promise.resolve(answer(403, refusal("not_carried")));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      if (FORWARDED.includes(name)) headers[name] = value;
    });
    const body = typeof init.body === "string" ? init.body : undefined;
    const id = crypto.randomUUID();
    const request: CourierRequest = { v: 1, type: "request", id, method, path, headers, body };
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(answer(504, refusal("sign_in_window_unavailable")));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        waiting.delete(id);
        reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      init.signal?.addEventListener("abort", abort, { once: true });
      waiting.set(id, ({ status, body: text }) => {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", abort);
        waiting.delete(id);
        resolve(answer(status, text));
      });
      try {
        send(JSON.stringify(request));
      } catch {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(answer(503, refusal("sign_in_window_unavailable")));
      }
    });
  };
  const receive = (message: CourierMessage) => {
    if (message.type === "response") waiting.get(message.id)?.(message);
  };
  /** The window closed: every call still waiting fails now. */
  const closed = () => {
    for (const settle of [...waiting.values()])
      settle({ status: 503, body: refusal("sign_in_window_unavailable") });
  };
  return { transport, receive, closed };
}

function answer(status: number, body: string): Response {
  // 204 and 304 cannot carry a body; the service answers neither here.
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

// ── The courier frame's side (account origin) ─────────────────────────────

export interface WindowDeps {
  fetch: typeof fetch;
  /** The CSRF token from the frame's cookie. */
  csrf(): string | undefined;
  reply(message: CourierMessage): void;
}

/** Whether the body asks to admit with a recovery proof (refused here). */
function asksRecovery(body: string | undefined): boolean {
  if (!body) return false;
  try {
    const value = JSON.parse(body) as { admission?: Record<string, unknown> };
    return !!value?.admission && "recovery_proof" in value.admission;
  } catch {
    return false;
  }
}

/** Carries one request for the pane, if it is one the frame carries. */
export async function carry(deps: WindowDeps, request: CourierRequest): Promise<void> {
  const respond = (status: number, body: string) =>
    deps.reply({ v: 1, type: "response", id: request.id, status, body });
  if (!carried(request.method, request.path)) return respond(403, refusal("not_carried"));
  if ((request.body?.length ?? 0) > MAX_BODY) return respond(413, refusal("too_large"));
  if (asksRecovery(request.body)) return respond(403, refusal("recovery_not_carried"));
  const headers = new Headers({ Accept: "application/json", ...request.headers });
  if (request.body !== undefined) headers.set("Content-Type", "application/json");
  const csrf = deps.csrf();
  if (csrf) headers.set("x-csrf-token", csrf);
  try {
    const response = await deps.fetch(request.path, {
      method: request.method,
      headers,
      body: request.method === "POST" ? (request.body ?? "") : undefined,
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (text.length > MAX_ANSWER) return respond(502, refusal("response_too_large"));
    respond(response.status, text);
  } catch {
    respond(503, refusal("unavailable"));
  }
}

/** The CSRF cookie the account service sets, as `api.ts` reads it. */
export function csrfFromCookie(cookie: string): string | undefined {
  const raw = cookie
    .split("; ")
    .find((x) => x.startsWith("subrosa_csrf="))
    ?.slice("subrosa_csrf=".length);
  return raw ? decodeURIComponent(raw) : undefined;
}
