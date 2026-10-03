// How the gallery is organised: collections (shown as folders), favourites
// and hidden items. Stored natively and synchronised with the account
// (ADR-0073); this is the typed face of `studio_library.rs`.

import { invoke } from "@tauri-apps/api/core";
import type { StudioArtifact } from "./types";

export interface StudioCollection {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioMark {
  /** The UUID stem of the gallery file name. */
  id: string;
  collectionId: string | null;
  favorite: boolean;
  hidden: boolean;
}

export interface StudioLibrary {
  collections: StudioCollection[];
  /** By mark id (the file's UUID stem). */
  marks: Map<string, StudioMark>;
}

export const EMPTY_LIBRARY: StudioLibrary = { collections: [], marks: new Map() };

/** The id a gallery file's mark is filed under: its UUID stem. */
export function markIdOf(artifact: Pick<StudioArtifact, "fileName">): string {
  const dot = artifact.fileName.lastIndexOf(".");
  return (dot > 0 ? artifact.fileName.slice(0, dot) : artifact.fileName).toLowerCase();
}

/** Whether a gallery file can carry a mark: only the files this app named. */
export function canMark(artifact: Pick<StudioArtifact, "fileName">): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(markIdOf(artifact));
}

export function markOf(library: StudioLibrary, artifact: StudioArtifact): StudioMark | undefined {
  return library.marks.get(markIdOf(artifact));
}

export async function loadLibrary(): Promise<StudioLibrary> {
  const raw = await invoke<{ collections: StudioCollection[]; marks: StudioMark[] }>(
    "studio_library_list",
  );
  return {
    collections: raw.collections,
    marks: new Map(raw.marks.map((mark) => [mark.id, mark])),
  };
}

/** Changes the marks of some gallery files at once. A field left out is left
 * alone; `collectionId: null` takes them out of their collection. */
export async function markArtifacts(
  artifacts: StudioArtifact[],
  change: { favorite?: boolean; hidden?: boolean; collectionId?: string | null },
): Promise<void> {
  const ids = artifacts.filter(canMark).map((artifact) => artifact.fileName);
  if (ids.length === 0) return;
  await invoke("studio_library_mark", { request: { ids, ...change } });
}

export function saveCollection(name: string, id?: string): Promise<StudioCollection> {
  return invoke<StudioCollection>("studio_collection_save", { id: id ?? null, name });
}

export function deleteCollection(id: string): Promise<void> {
  return invoke("studio_collection_delete", { id });
}

/** The library as it would be after a change, so the grid answers a tap at
 * once and the native write catches up. */
export function withMarks(
  library: StudioLibrary,
  artifacts: StudioArtifact[],
  change: { favorite?: boolean; hidden?: boolean; collectionId?: string | null },
): StudioLibrary {
  const marks = new Map(library.marks);
  for (const artifact of artifacts.filter(canMark)) {
    const id = markIdOf(artifact);
    const current = marks.get(id) ?? { id, collectionId: null, favorite: false, hidden: false };
    marks.set(id, {
      ...current,
      ...(change.favorite !== undefined ? { favorite: change.favorite } : {}),
      ...(change.hidden !== undefined ? { hidden: change.hidden } : {}),
      ...(change.collectionId !== undefined ? { collectionId: change.collectionId } : {}),
    });
  }
  return { ...library, marks };
}
