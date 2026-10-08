import { ApiError, boundedJson } from "./api";

/**
 * The public assistant catalog (ADR-0097). Everything here is public: no
 * account, no cookie, nothing sealed. The reads go to this origin's own
 * service, like a share's, and nothing the service returns is ever rendered
 * as markup: names, instructions and references are text.
 */
export const CATEGORIES = [
  "writing",
  "research",
  "learning",
  "productivity",
  "creative",
  "coding",
  "lifestyle",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Author = { handle: string; display_name: string };
export type ListingSummary = {
  id: string;
  name: string;
  description: string;
  category: Category;
  import_count: number;
  reference_count: number;
  updated_at: string;
  author: Author | null;
};
export type Listing = ListingSummary & {
  instructions: string;
  starter: string;
  permissions: string[];
  references: { name: string; text: string }[];
  published_at: string;
};
export type ReportReason = "spam" | "abuse" | "illegal" | "privacy" | "other";

const LISTING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The listing id in `/assistants/<id>`, or null for the catalog itself and
 * for anything that is not an id. */
export function listingIdOf(path: string): string | null {
  const match = /^\/assistants\/([^/]+)$/.exec(path);
  return match && LISTING_ID.test(match[1]) ? match[1].toLowerCase() : null;
}

/** The link that opens the app on this listing. It carries the id and
 * nothing else: the app reads the listing from its own account site. */
export function importLink(id: string): string {
  if (!LISTING_ID.test(id)) throw new Error("Invalid listing id.");
  return `subrosa://assistant/import?id=${id.toLowerCase()}`;
}

async function publicJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "omit",
    redirect: "error",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: init.signal ?? AbortSignal.timeout(20000),
  });
  const value = (await boundedJson(response)) as { data?: T; error?: { code?: string } } | null;
  if (!response.ok)
    throw new ApiError(
      value?.error?.code ?? (response.status === 404 ? "not_found" : "unavailable"),
      "The catalog could not be read.",
      response.status,
    );
  if (!value || !("data" in value))
    throw new ApiError("invalid_response", "The service returned an invalid response.", 502);
  return value.data as T;
}

export function searchCatalog(
  query: { q?: string; category?: Category | ""; page?: number },
  signal?: AbortSignal,
): Promise<ListingSummary[]> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim().slice(0, 100));
  if (query.category) params.set("category", query.category);
  if (query.page) params.set("page", String(query.page));
  const suffix = params.toString();
  return publicJson<ListingSummary[]>(`/api/v1/catalog/assistants${suffix ? `?${suffix}` : ""}`, {
    signal,
  });
}

export function readListing(id: string, signal?: AbortSignal): Promise<Listing> {
  if (!LISTING_ID.test(id)) return Promise.reject(new ApiError("not_found", "Not found.", 404));
  return publicJson<Listing>(`/api/v1/catalog/assistants/${id}`, { signal });
}

export function reportListing(id: string, reason: ReportReason, detail: string) {
  return publicJson<{ reported: boolean }>("/api/v1/reports", {
    method: "POST",
    body: JSON.stringify({
      target_kind: "assistant",
      target_id: id,
      reason,
      detail: detail.trim().slice(0, 500),
    }),
  });
}
