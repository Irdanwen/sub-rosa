/**
 * Publishing from the browser (ADR-0097): a note or a canvas as a public
 * page, pages gathered into a site, the public profile, and an assistant in
 * the catalog. The requests are the app's (`account/publications.rs`): the
 * page id is new and its `source_id` is the note's, a republished note keeps
 * its page and its address, the slug is the title folded the app's way with a
 * random tail, and a listing carries only the references the person ticked.
 *
 * Unlike a share, what is published is plaintext the service renders and
 * serves on its own origin until it is unpublished. Nothing here is stored in
 * the browser: the service is the authority on what is published.
 */
import { CATEGORIES, type Category, type Listing } from "../lib/catalog";
import { api } from "../lib/api";
import {
  type AssistantDefinition,
  type AssistantReference,
  PERMISSIONS,
  addReference,
  saveAssistant,
} from "./assistants";
import type { SyncClient } from "./sync";

export interface PublishedPage {
  id: string;
  slug: string;
  title: string;
  kind: "note" | "canvas";
  source_id: string;
  source_digest: string;
  site_id: string | null;
  bytes: number;
  published_at: string;
  updated_at: string;
  taken_down: boolean;
}
export interface PublishedSite {
  id: string;
  title: string;
  home_page_id: string | null;
  page_ids: string[];
  updated_at: string;
  taken_down: boolean;
}
export interface PublicProfile {
  handle: string;
  display_name: string;
  bio: string;
  has_avatar: boolean;
  updated_at: string;
  taken_down: boolean;
}
export interface PublishedListing {
  id: string;
  source_id: string;
  name: string;
  category: Category;
  updated_at: string;
  taken_down: boolean;
}
export interface Publications {
  publication_url: string;
  profile: PublicProfile | null;
  pages: PublishedPage[];
  sites: PublishedSite[];
  assistants: PublishedListing[];
}

/** The service's routes, swappable in tests. */
export interface PublishTransport {
  get<T>(path: string): Promise<T>;
  send<T>(method: "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
  sendBytes<T>(path: string, bytes: Uint8Array): Promise<T>;
}
export const servicePublishTransport: PublishTransport = {
  get: (path) => api(path),
  send: (method, path, body) =>
    api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  sendBytes: (path, bytes) =>
    api(path, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
};

const FOLD: Record<string, string> = {};
for (const [to, from] of Object.entries({
  a: "àáâãäå",
  c: "ç",
  e: "èéêë",
  i: "ìíîï",
  n: "ñ",
  o: "òóôõöø",
  u: "ùúûü",
  y: "ýÿ",
  s: "ß",
}))
  for (const char of from) FOLD[char] = to;

/** `slug_for`: the title folded to `[a-z0-9-]`, at most about forty
 * characters, then a tail that keeps two pages of one title apart. */
export function slugFor(title: string, tail: string): string {
  let slug = "";
  for (const char of title.toLowerCase()) {
    const folded = FOLD[char] ?? char;
    if (/^[a-z0-9]$/.test(folded)) slug += folded;
    else if (slug && !slug.endsWith("-")) slug += "-";
    if (slug.length >= 40) break;
  }
  slug = slug.replace(/-+$/, "");
  return `${slug || "page"}-${tail}`;
}

const randomTail = () => crypto.randomUUID().replace(/-/g, "").slice(0, 6);

export function publications(transport = servicePublishTransport): Promise<Publications> {
  return transport.get<Publications>("/api/v1/publications");
}

/** Publishes a note (or a canvas) as it is now, or publishes its changes. */
export async function publishNote(
  note: { id: string; title: string; body: string },
  kind: "note" | "canvas" = "note",
  transport = servicePublishTransport,
): Promise<{ page: PublishedPage; url: string }> {
  const overview = await publications(transport);
  const existing = overview.pages.find((page) => page.source_id === note.id);
  const title = Array.from(note.title.trim() || "Untitled")
    .slice(0, 200)
    .join("");
  if (!note.body.trim()) throw new Error("There is nothing to publish yet.");
  const body = (slug: string) => ({ slug, title, kind, source_id: note.id, markdown: note.body });
  const id = existing?.id ?? crypto.randomUUID();
  let page: PublishedPage;
  try {
    page = await transport.send<PublishedPage>(
      "PUT",
      `/api/v1/publications/pages/${id}`,
      body(existing?.slug ?? slugFor(title, randomTail())),
    );
  } catch (error) {
    // A new page whose address another already uses gets one more tail.
    if (existing || (error as { code?: string }).code !== "slug_taken") throw error;
    page = await transport.send<PublishedPage>(
      "PUT",
      `/api/v1/publications/pages/${id}`,
      body(slugFor(title, randomTail())),
    );
  }
  return { page, url: `${overview.publication_url}/p/${page.slug}` };
}

export function unpublishPage(id: string, transport = servicePublishTransport) {
  return transport.send("DELETE", `/api/v1/publications/pages/${id}`);
}

export function saveSite(
  site: { id?: string; title: string; homePageId: string | null; pageIds: string[] },
  transport = servicePublishTransport,
): Promise<PublishedSite> {
  return transport.send<PublishedSite>(
    "PUT",
    `/api/v1/publications/sites/${site.id ?? crypto.randomUUID()}`,
    {
      title: site.title.trim(),
      home_page_id: site.homePageId,
      page_ids: site.pageIds,
    },
  );
}

export function deleteSite(id: string, transport = servicePublishTransport) {
  return transport.send("DELETE", `/api/v1/publications/sites/${id}`);
}

export function saveProfile(
  profile: { handle: string; displayName: string; bio: string },
  transport = servicePublishTransport,
): Promise<PublicProfile> {
  return transport.send<PublicProfile>("PUT", "/api/v1/publications/profile", {
    handle: profile.handle.trim().toLowerCase(),
    display_name: profile.displayName.trim(),
    bio: profile.bio.trim(),
  });
}

export function deleteProfile(transport = servicePublishTransport) {
  return transport.send("DELETE", "/api/v1/publications/profile");
}

/** The avatar the service sniffs: PNG, JPEG or WebP, 256 KiB at most. */
export const MAX_AVATAR_BYTES = 256 * 1024;
export function setAvatar(bytes: Uint8Array, transport = servicePublishTransport) {
  if (bytes.byteLength > MAX_AVATAR_BYTES) throw new Error("The picture is too large.");
  return transport.sendBytes<{ avatar: boolean }>("/api/v1/publications/profile/avatar", bytes);
}
export function clearAvatar(transport = servicePublishTransport) {
  return transport.send<{ avatar: boolean }>("DELETE", "/api/v1/publications/profile/avatar");
}

/** The permissions a listing may request: the assistant's tools the catalog
 * knows, and notes and memory when it reads them. Never a connector. */
export function listingPermissions(definition: AssistantDefinition): string[] {
  return [
    ...new Set([
      ...definition.tools.filter((tool) => (PERMISSIONS as readonly string[]).includes(tool)),
      ...(definition.allow_notes ? ["notes"] : []),
      ...(definition.allow_memory ? ["memory"] : []),
    ]),
  ].sort();
}

/** Publishes (or republishes) an assistant in the catalog. */
export async function publishAssistant(
  definition: AssistantDefinition,
  options: {
    category: Category;
    description: string;
    references: AssistantReference[];
  },
  transport = servicePublishTransport,
): Promise<PublishedListing> {
  if (!(CATEGORIES as readonly string[]).includes(options.category))
    throw new Error("Choose a category.");
  const overview = await publications(transport);
  const existing = overview.assistants.find((listing) => listing.source_id === definition.id);
  return transport.send<PublishedListing>(
    "PUT",
    `/api/v1/publications/assistants/${existing?.id ?? crypto.randomUUID()}`,
    {
      source_id: definition.id,
      name: definition.name,
      description: options.description.trim() || definition.description,
      category: options.category,
      instructions: definition.instructions,
      starter: definition.opening_message,
      permissions: listingPermissions(definition),
      references: options.references
        .filter((reference) => reference.status === "ready" && reference.text.trim())
        .map((reference) => ({ name: reference.name, text: reference.text })),
    },
  );
}

export function unpublishAssistant(id: string, transport = servicePublishTransport) {
  return transport.send("DELETE", `/api/v1/publications/assistants/${id}`);
}

/**
 * "Add to Sub Rosa" from the web (`imported_definition`): the listing is read
 * from this origin's catalog by id, every permission it asks for is granted
 * only when the person ticked it, and it becomes an ordinary assistant of
 * the account. Counts one import.
 */
export async function importListing(
  sync: SyncClient,
  id: string,
  granted: string[],
  transport = servicePublishTransport,
): Promise<string> {
  const listing = await transport.send<Listing>("POST", `/api/v1/catalog/assistants/${id}/import`);
  const allowed = (key: string) => listing.permissions.includes(key) && granted.includes(key);
  const assistantId = await saveAssistant(sync, {
    name: Array.from(listing.name).slice(0, 200).join(""),
    description: Array.from(listing.description).slice(0, 4000).join(""),
    instructions: listing.instructions,
    model: "",
    openingMessage: listing.starter,
    tools: PERMISSIONS.filter(allowed),
    allowNotes: allowed("notes"),
    allowMemory: allowed("memory"),
  });
  for (const reference of listing.references.slice(0, 10))
    if (reference.text.trim() && reference.text.length <= 240_000)
      await addReference(sync, assistantId, {
        name: reference.name,
        format: "md",
        text: reference.text,
      });
  return assistantId;
}
