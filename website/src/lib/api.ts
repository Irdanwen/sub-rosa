export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
let accountScope: string | null = null;
export function setAccountScope(id: string | null) {
  accountScope = id;
}
export interface Account {
  id: string;
  email: string;
  created_at: string;
}
export interface Device {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}
export interface Change {
  sequence: number;
  operation_id: string;
  object_id: string;
  revision: string;
  parent_revision: string | null;
  resolved_revisions?: string[];
  kind: string;
  ciphertext: string;
  deleted: boolean;
  device_id: string;
}
export interface SyncPage {
  changes: Change[];
  cursor: number;
  has_more: boolean;
}
export interface VaultRecord {
  version: number;
  envelope: string;
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith("/api/v1/") && path !== "/auth/logout") throw new Error("Invalid API path");
  if (
    !accountScope &&
    !(path === "/api/v1/me" && (!init.method || init.method === "GET")) &&
    path !== "/api/v1/passkeys/authenticate/start" &&
    path !== "/api/v1/passkeys/authenticate/finish" &&
    path !== "/auth/logout"
  )
    throw new ApiError("account_not_loaded", "Load the account before accessing its data.", 401);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (accountScope) headers.set("x-subrosa-account-id", accountScope);
  if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
  const csrf = document.cookie
    .split("; ")
    .find((x) => x.startsWith("subrosa_csrf="))
    ?.slice("subrosa_csrf=".length);
  if (csrf) headers.set("x-csrf-token", decodeURIComponent(csrf));
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(20000),
  });
  const value = await boundedJson(response);
  const body =
    value && typeof value === "object"
      ? (value as { data?: unknown; error?: { code?: string } })
      : null;
  if (body?.error?.code === "account_mismatch") {
    accountScope = null;
    window.dispatchEvent(new Event("subrosa:account-session-changed"));
  }
  if (!response.ok)
    throw new ApiError(
      body?.error?.code ?? "unavailable",
      "The request could not be completed.",
      response.status,
    );
  if (!body || !("data" in body))
    throw new ApiError("invalid_response", "The service returned an invalid response.", 502);
  return body.data as T;
}
export async function boundedJson(response: Response): Promise<unknown> {
  const maxBytes = 8 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new ApiError("response_too_large", "Response exceeds the size limit.", 413);
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ApiError("response_too_large", "Response exceeds the size limit.", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return null;
  } finally {
    reader.releaseLock();
  }
}

export function revisionHeads(changes: Change[]): Change[] {
  const parents = new Set(
    changes.flatMap((change) => [change.parent_revision, ...(change.resolved_revisions ?? [])]),
  );
  return changes.filter((change) => !parents.has(change.revision));
}

/** The kinds a browser reads. Bounded on purpose: the page holds a decryption
 * key, so what it is allowed to pull is a decision, not a parameter. */
export type ReadableKind = "settings" | "usage" | "note";

export async function readChanges(signal?: AbortSignal, kind?: ReadableKind): Promise<Change[]> {
  let cursor = 0;
  let bytes = 0;
  const changes: Change[] = [];
  // Bounded to avoid a hostile service exhausting browser memory.
  for (let page = 0; page < 100; page++) {
    const result = await api<SyncPage>(
      `/api/v1/sync?after=${cursor}&limit=100${kind ? `&kind=${kind}` : ""}`,
      { signal },
    );
    if (
      !Array.isArray(result.changes) ||
      result.changes.length > 100 ||
      typeof result.has_more !== "boolean" ||
      !Number.isSafeInteger(result.cursor) ||
      result.cursor < cursor
    )
      throw new Error("Invalid sync cursor");
    for (const change of result.changes) {
      if (
        typeof change.ciphertext !== "string" ||
        typeof change.object_id !== "string" ||
        typeof change.revision !== "string" ||
        typeof change.operation_id !== "string" ||
        typeof change.deleted !== "boolean" ||
        !Number.isSafeInteger(change.sequence) ||
        change.sequence <= cursor ||
        change.sequence > result.cursor ||
        (kind && change.kind !== kind)
      )
        throw new ApiError("invalid_response", "Invalid sync revision.", 502);
      bytes += change.ciphertext.length;
      if (bytes > 32 * 1024 * 1024)
        throw new ApiError("history_too_large", "Open the app to view this history.", 413);
      changes.push(change);
    }
    if (!result.has_more) return changes;
    if (result.cursor === cursor) throw new Error("Sync cursor did not advance");
    cursor = result.cursor;
  }
  throw new ApiError("history_too_large", "Open the app to view this history.", 413);
}
