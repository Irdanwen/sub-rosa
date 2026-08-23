/**
 * Chat blocks — rich inline cards inside assistant replies (ADR-0024).
 *
 * The model embeds a fenced code block whose info string is `subrosa:<kind>`
 * and whose body is one JSON object. Both markdown renderers (the desktop
 * renderer in AgentWorkspace and the mobile SimpleMarkdown) intercept the
 * fence and mount a card. The payload travels IN the message text on purpose:
 * it persists as-is in `agent_messages.content` and in Hermes transcripts, so
 * cards survive reload, history, copy, and export with no schema change — and
 * a build without this parser shows a readable JSON code block instead.
 *
 * Everything here treats the payload as untrusted model output: parse never
 * throws, every string is length-capped, URLs must be https, and anything
 * that fails validation falls back to the plain code-block rendering at the
 * call site (return null — never a half-valid card).
 */

export const CHAT_BLOCK_FENCE_PREFIX = "subrosa:";

export type ChatBlockLink = {
  title: string;
  url: string;
  /** Registrable host of `url`, derived here — never trusted from the model. */
  domain: string;
  snippet?: string;
  publishedAt?: string;
};

export type LinksChatBlock = {
  kind: "links";
  title?: string;
  links: ChatBlockLink[];
};

export type ChatBlockPlace = {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  category?: string;
  url?: string;
  rating?: number;
  reviews?: number;
  /** One short model-authored sentence; everything else comes from the tool. */
  note?: string;
  /** Opaque Google photo reference; resolved to bytes by the Rust side. */
  photoRef?: string;
};

export type PlacesChatBlock = {
  kind: "places";
  title?: string;
  /** Which provider's data this is — rendered as the card's attribution. */
  attribution: "osm" | "google";
  places: ChatBlockPlace[];
};

export type ChatBlockNote = {
  id: string;
  title: string;
  snippet?: string;
};

/** The user's own notes, cited as tappable cards that open in the app. */
export type NotesChatBlock = {
  kind: "notes";
  title?: string;
  notes: ChatBlockNote[];
};

/** One thing the assistant offers to do. Nothing runs without a tap. */
export type ProposedAction =
  | { kind: "reminder"; id: string; label: string; due?: string }
  | { kind: "event"; id: string; label: string; start: string; end?: string }
  | { kind: "note"; id: string; label: string; noteId: string; text: string }
  /** Read one of the user's recordings end to end (ADR-0027). Behind a tap
   * because it costs several model calls. */
  | { kind: "summarize"; id: string; label: string; noteId: string }
  /** Fetch a link and turn it into a note (ADR-0028). */
  | { kind: "importLink"; id: string; label: string; url: string };

export type ProposalChatBlock = {
  kind: "proposal";
  title?: string;
  /** Identifies the proposal so its "done" state can live outside the text
   * (a message is immutable — see ADR-0024 and crate::actions). */
  proposalId: string;
  actions: ProposedAction[];
};

export type ChatBlock = LinksChatBlock | PlacesChatBlock | NotesChatBlock | ProposalChatBlock;

/** Display caps. Clamping (not rejecting) keeps a slightly-over payload
 * useful; a payload with nothing valid inside still returns null. */
const MAX_LINKS = 6;
const MAX_PLACES = 8;
const MAX_TITLE = 120;
const MAX_LINK_TITLE = 160;
const MAX_SNIPPET = 280;
const MAX_URL = 2048;
const MAX_PLACE_NAME = 120;
const MAX_PLACE_ADDRESS = 160;
const MAX_PLACE_CATEGORY = 60;
const MAX_PLACE_NOTE = 200;
const MAX_PHOTO_REF = 512;
const MAX_NOTES = 6;
const MAX_NOTE_ID = 64;
const MAX_ACTIONS = 5;

/** The `<kind>` of a `subrosa:<kind>` fence info string, or null. */
export function chatBlockKindOf(info: string): string | null {
  const lang = info.trim().toLowerCase();
  if (!lang.startsWith(CHAT_BLOCK_FENCE_PREFIX)) return null;
  const kind = lang.slice(CHAT_BLOCK_FENCE_PREFIX.length).trim();
  return kind || null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cappedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** https-only, parseable, bounded. Returns the normalized href + host. */
function safeHttpsUrl(value: unknown): { url: string; domain: string } | null {
  if (typeof value !== "string" || value.length > MAX_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return null;
  return { url: parsed.href, domain: parsed.hostname.replace(/^www\./, "") };
}

function parseLinks(payload: Record<string, unknown>): LinksChatBlock | null {
  const raw = payload.links;
  if (!Array.isArray(raw)) return null;
  const links: ChatBlockLink[] = [];
  for (const entry of raw) {
    if (links.length >= MAX_LINKS) break;
    const item = asObject(entry);
    if (!item) continue;
    const target = safeHttpsUrl(item.url);
    const title = cappedString(item.title, MAX_LINK_TITLE);
    if (!target || !title) continue;
    links.push({
      title,
      url: target.url,
      domain: target.domain,
      snippet: cappedString(item.snippet, MAX_SNIPPET),
      publishedAt: cappedString(item.publishedAt, 40),
    });
  }
  if (links.length === 0) return null;
  return { kind: "links", title: cappedString(payload.title, MAX_TITLE), links };
}

/** Google photo references only: `places/<id>/photos/<id>`, tight charset. */
function safePhotoRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ref = value.trim();
  if (!ref || ref.length > MAX_PHOTO_REF) return undefined;
  if (!ref.startsWith("places/") || !ref.includes("/photos/")) return undefined;
  return /^[\w/-]+$/.test(ref) ? ref : undefined;
}

function finiteInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

function parsePlaces(payload: Record<string, unknown>): PlacesChatBlock | null {
  const raw = payload.places;
  if (!Array.isArray(raw)) return null;
  const places: ChatBlockPlace[] = [];
  for (const entry of raw) {
    if (places.length >= MAX_PLACES) break;
    const item = asObject(entry);
    if (!item) continue;
    const name = cappedString(item.name, MAX_PLACE_NAME);
    const lat = finiteInRange(item.lat, -90, 90);
    const lng = finiteInRange(item.lng, -180, 180);
    if (!name || lat === undefined || lng === undefined) continue;
    const rating = finiteInRange(item.rating, 0, 5);
    const reviews = finiteInRange(item.reviews, 0, 10_000_000);
    places.push({
      name,
      lat,
      lng,
      address: cappedString(item.address, MAX_PLACE_ADDRESS),
      category: cappedString(item.category, MAX_PLACE_CATEGORY),
      url: safeHttpsUrl(item.url)?.url,
      rating: rating === undefined ? undefined : Math.round(rating * 10) / 10,
      reviews: reviews === undefined ? undefined : Math.round(reviews),
      note: cappedString(item.note, MAX_PLACE_NOTE),
      photoRef: safePhotoRef(item.photoRef),
    });
  }
  if (places.length === 0) return null;
  return {
    kind: "places",
    title: cappedString(payload.title, MAX_TITLE),
    attribution: payload.attribution === "google" ? "google" : "osm",
    places,
  };
}

function parseNotes(payload: Record<string, unknown>): NotesChatBlock | null {
  const raw = payload.notes;
  if (!Array.isArray(raw)) return null;
  const notes: ChatBlockNote[] = [];
  for (const entry of raw) {
    if (notes.length >= MAX_NOTES) break;
    const item = asObject(entry);
    if (!item) continue;
    const title = cappedString(item.title, MAX_LINK_TITLE);
    const id = typeof item.id === "string" ? item.id.trim() : "";
    // Note ids are app-generated tokens; anything looser than this is not one.
    if (!title || !id || id.length > MAX_NOTE_ID || !/^[\w-]+$/.test(id)) continue;
    notes.push({ id, title, snippet: cappedString(item.snippet, MAX_SNIPPET) });
  }
  if (notes.length === 0) return null;
  return { kind: "notes", title: cappedString(payload.title, MAX_TITLE), notes };
}

function parseProposal(payload: Record<string, unknown>): ProposalChatBlock | null {
  const raw = payload.actions;
  const proposalId = typeof payload.proposalId === "string" ? payload.proposalId.trim() : "";
  // Without a stable id there is nowhere to record what was done, so the
  // card could only ever offer to do it again. Refuse it.
  if (!Array.isArray(raw) || !proposalId || !/^[\w-]{1,64}$/.test(proposalId)) return null;
  const actions: ProposedAction[] = [];
  for (const entry of raw) {
    if (actions.length >= MAX_ACTIONS) break;
    const item = asObject(entry);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = cappedString(item.label, MAX_LINK_TITLE);
    if (!label || !id || !/^[\w-]{1,64}$/.test(id)) continue;
    if (item.kind === "reminder") {
      actions.push({ kind: "reminder", id, label, due: isoDate(item.due) });
    } else if (item.kind === "event") {
      const start = isoDate(item.start);
      if (!start) continue;
      actions.push({ kind: "event", id, label, start, end: isoDate(item.end) });
    } else if (item.kind === "note") {
      const noteId = typeof item.noteId === "string" ? item.noteId.trim() : "";
      const text = cappedString(item.text, 2_000);
      if (!noteId || !/^[\w-]{1,64}$/.test(noteId) || !text) continue;
      actions.push({ kind: "note", id, label, noteId, text });
    } else if (item.kind === "summarize") {
      const noteId = typeof item.noteId === "string" ? item.noteId.trim() : "";
      if (!noteId || !/^[\w-]{1,64}$/.test(noteId)) continue;
      actions.push({ kind: "summarize", id, label, noteId });
    } else if (item.kind === "importLink") {
      const url = cappedString(item.url, MAX_URL);
      // Only web links: the Rust side refuses the rest anyway, and refusing
      // here keeps a nonsense card from ever rendering.
      if (!url || !/^https?:\/\//i.test(url)) continue;
      actions.push({ kind: "importLink", id, label, url });
    }
  }
  if (actions.length === 0) return null;
  return {
    kind: "proposal",
    title: cappedString(payload.title, MAX_TITLE),
    proposalId,
    actions,
  };
}

/** A date we can actually read, or nothing — never a guess. */
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * The one fence-dispatch decision, shared by both markdown renderers so they
 * can never disagree: `card` for a valid payload, `skeleton` for a fence
 * still streaming in, `code` for everything else a subrosa fence degrades
 * to, and null for fences that are not chat blocks at all.
 */
export type ChatBlockRender =
  | { type: "card"; block: ChatBlock }
  | { type: "skeleton" }
  | { type: "code" };

export function resolveChatBlockFence(
  info: string,
  body: string,
  terminated: boolean,
  streaming: boolean,
): ChatBlockRender | null {
  if (!chatBlockKindOf(info)) return null;
  const block = parseChatBlock(info, body);
  // A complete payload renders as the card even before its closing fence
  // arrives; a half-streamed one holds the card's silhouette.
  if (block) return { type: "card", block };
  if (!terminated && streaming) return { type: "skeleton" };
  return { type: "code" };
}

/**
 * Replaces every valid chat block in a reply with its readable plain-text
 * form, for the copy-reply paths: pasting a reply elsewhere should carry the
 * sources as a list, not a JSON fence. Invalid blocks stay verbatim — they
 * are what the user saw.
 */
export function chatBlocksToClipboardText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith("```")) {
      out.push(lines[index]);
      continue;
    }
    const info = trimmed.slice(3).trim();
    const body: string[] = [];
    let end = index + 1;
    while (end < lines.length && !lines[end].trim().startsWith("```")) {
      body.push(lines[end]);
      end += 1;
    }
    const block = chatBlockKindOf(info) ? parseChatBlock(info, body.join("\n")) : null;
    if (block) {
      out.push(...chatBlockPlainText(block));
    } else {
      out.push(lines[index], ...body);
      if (end < lines.length) out.push(lines[end]);
    }
    index = end;
  }
  return out.join("\n");
}

function chatBlockPlainText(block: ChatBlock): string[] {
  switch (block.kind) {
    case "links":
      return [
        block.title || "Sources",
        ...block.links.map((link) => `- ${link.title}: ${link.url}`),
      ];
    case "places":
      return [
        block.title || "Places",
        ...block.places.map((place) => {
          const details = [
            place.category,
            place.rating !== undefined ? `${place.rating}/5` : undefined,
            place.address,
          ]
            .filter(Boolean)
            .join(", ");
          return details ? `- ${place.name} (${details})` : `- ${place.name}`;
        }),
      ];
    case "notes":
      return [block.title || "Notes", ...block.notes.map((note) => `- ${note.title}`)];
    case "proposal":
      return [
        block.title || "Suggested follow-ups",
        ...block.actions.map((action) => `- ${action.label}`),
      ];
    default:
      return [];
  }
}

/**
 * Parses a `subrosa:<kind>` fence body into a card payload. Returns null for
 * non-block fences, unknown kinds, malformed JSON, unsupported versions, and
 * payloads with no valid content — the caller then renders the fence as the
 * ordinary code block it degrades to.
 */
export function parseChatBlock(info: string, body: string): ChatBlock | null {
  const kind = chatBlockKindOf(info);
  if (!kind) return null;
  let payload: Record<string, unknown> | null = null;
  try {
    payload = asObject(JSON.parse(body));
  } catch {
    return null;
  }
  if (payload === null || payload.v !== 1) return null;
  switch (kind) {
    case "links":
      return parseLinks(payload);
    case "places":
      return parsePlaces(payload);
    case "notes":
      return parseNotes(payload);
    case "proposal":
      return parseProposal(payload);
    default:
      return null;
  }
}
