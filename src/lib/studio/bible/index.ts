/**
 * The bible, from the webview: the persistent identities of a production.
 *
 * See `src-tauri/src/bible.rs` for what is stored and why, and `./prompt` for
 * the part that matters at render time - the ordered reference stack, the
 * invariant traits restated every shot, and the word budget.
 */

import { invoke } from "@tauri-apps/api/core";
import type { StudioArtifact } from "../types";
import type { BibleEntry, BibleKind, BibleRef, BibleRole } from "./types";

export * from "./prompt";
export * from "./types";

export async function listBibleEntries(): Promise<BibleEntry[]> {
  return invoke<BibleEntry[]>("list_bible_entries");
}

export async function saveBibleEntry(request: {
  id?: string;
  kind: BibleKind;
  name: string;
  traits?: string;
  note?: string;
}): Promise<string> {
  return invoke<string>("save_bible_entry", { request });
}

export async function deleteBibleEntry(id: string): Promise<void> {
  return invoke<void>("delete_bible_entry", { id });
}

export async function addBibleRef(request: {
  entryId: string;
  artifactId: string;
  role: BibleRole;
  label?: string;
}): Promise<string> {
  return invoke<string>("add_bible_ref", { request });
}

export async function removeBibleRef(id: string): Promise<void> {
  return invoke<void>("remove_bible_ref", { id });
}

export async function reorderBibleRefs(entryId: string, refIds: string[]): Promise<void> {
  return invoke<void>("reorder_bible_refs", { request: { entryId, refIds } });
}

/**
 * Resolve a reference against what is actually in the gallery.
 *
 * A reference is a pointer, and the gallery is reconciled against the disk:
 * its index is capped, halved under quota pressure, and adopts files it does
 * not recognise. So a reference can legitimately point at nothing, and the
 * honest answer is to say so rather than to repair or delete it.
 */
export function resolveRef(
  reference: BibleRef,
  artifacts: readonly StudioArtifact[],
): StudioArtifact | undefined {
  return artifacts.find((artifact) => artifact.id === reference.artifactId);
}

/** Which references of an entry no longer have a file behind them. */
export function missingRefs(entry: BibleEntry, artifacts: readonly StudioArtifact[]): BibleRef[] {
  return entry.refs.filter((reference) => !resolveRef(reference, artifacts));
}
