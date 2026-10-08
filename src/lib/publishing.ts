import { invoke } from "@tauri-apps/api/core";
import type { AssistantDefinition } from "./assistants";

/**
 * Publishing (ADR-0097): a note, a canvas or an assistant made public on
 * purpose. Unlike a share (ADR-0053), what is published is readable by
 * anybody, has no end date, and stays until it is unpublished. The service
 * is the authority on what is published; nothing here is stored locally.
 */

/** The catalog's categories, in the service's words. */
export const CATALOG_CATEGORIES = [
  "writing",
  "research",
  "learning",
  "productivity",
  "creative",
  "coding",
  "lifestyle",
  "other",
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export type PublishedPage = {
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
};
export type PublishedSite = {
  id: string;
  title: string;
  home_page_id: string | null;
  page_ids: string[];
  updated_at: string;
  taken_down: boolean;
};
export type PublicProfile = {
  handle: string;
  display_name: string;
  bio: string;
  has_avatar: boolean;
  updated_at: string;
  taken_down: boolean;
};
export type ListingReference = { name: string; text: string };
export type AssistantListing = {
  id: string;
  source_id: string;
  name: string;
  description: string;
  category: CatalogCategory;
  instructions: string;
  starter: string;
  permissions: string[];
  references: ListingReference[];
  import_count: number;
  published_at: string;
  updated_at: string;
  author: { handle: string; display_name: string } | null;
  taken_down: boolean;
};
export type Publications = {
  publication_url: string;
  profile: PublicProfile | null;
  pages: PublishedPage[];
  sites: PublishedSite[];
  assistants: AssistantListing[];
};
export type NotePublication = {
  publication_url: string;
  page: PublishedPage | null;
  url: string | null;
  /** The note changed since it was last published. */
  changed: boolean;
};

export const publicPageUrl = (publicationUrl: string, slug: string) =>
  `${publicationUrl}/p/${slug}`;
export const publicProfileUrl = (publicationUrl: string, handle: string) =>
  `${publicationUrl}/u/${handle}`;

export const accountPublications = () => invoke<Publications>("account_publications");
export const notePublication = (noteId: string) =>
  invoke<NotePublication>("account_note_publication", { noteId });
export const publishNote = (noteId: string, kind: "note" | "canvas" = "note") =>
  invoke<NotePublication>("account_publish_note", { noteId, kind });
export const unpublishPage = (pageId: string) => invoke<void>("account_unpublish_page", { pageId });
export const savePublishedSite = (site: {
  id?: string;
  title: string;
  homePageId?: string | null;
  pageIds: string[];
}) => invoke<PublishedSite>("account_save_site", { site });
export const deletePublishedSite = (siteId: string) =>
  invoke<void>("account_delete_site", { siteId });
export const savePublicProfile = (profile: { handle: string; displayName: string; bio: string }) =>
  invoke<PublicProfile>("account_save_public_profile", { profile });
export const deletePublicProfile = () => invoke<void>("account_delete_public_profile");
/** A data URL or bare base64; null removes the picture. */
export const setPublicAvatar = (data: string | null) =>
  invoke<void>("account_set_public_avatar", { data });
export const publishAssistant = (request: {
  assistantId: string;
  description: string;
  category: CatalogCategory;
  referenceIds: string[];
}) => invoke<AssistantListing>("account_publish_assistant", { request });
export const unpublishAssistant = (listingId: string) =>
  invoke<void>("account_unpublish_assistant", { listingId });
/** Read from this app's own account site, never from an address a link carried. */
export const catalogListing = (listingId: string) =>
  invoke<AssistantListing>("catalog_assistant_listing", { listingId });
export const importCatalogAssistant = (listingId: string, granted: string[]) =>
  invoke<AssistantDefinition>("catalog_assistant_import", { listingId, granted });

/** A handle the service will accept: what the person typed, lowercased, with
 * anything else turned into single hyphens. */
export function normalizeHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}
export const isValidHandle = (value: string) =>
  /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,30}[a-z0-9]$/.test(value);
