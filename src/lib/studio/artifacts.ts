// Studio gallery: generated files live on disk (via the Rust artifact
// commands), the index lives in localStorage. Keeping bytes out of
// localStorage means the gallery survives restarts without quota pressure;
// reconciling against the disk on load drops entries whose file is gone.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { MediaFileResult } from "./async-job";
import type { ArtifactFile, ArtifactKind, StudioArtifact } from "./types";

const GALLERY_STORAGE_KEY = "os-june:studio-gallery";
const MAX_GALLERY_ENTRIES = 200;

export function artifactSrc(artifact: Pick<StudioArtifact, "path">): string {
  return convertFileSrc(artifact.path);
}

function readIndex(): StudioArtifact[] {
  try {
    const raw = window.localStorage.getItem(GALLERY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StudioArtifact[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(artifacts: StudioArtifact[]) {
  const capped = artifacts.slice(0, MAX_GALLERY_ENTRIES);
  try {
    window.localStorage.setItem(GALLERY_STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // Quota pressure: halve and retry once, else give up — files stay on disk
    // and the reconcile pass can rebuild a partial index later.
    try {
      window.localStorage.setItem(
        GALLERY_STORAGE_KEY,
        JSON.stringify(capped.slice(0, Math.max(5, Math.floor(capped.length / 2)))),
      );
    } catch {
      // Ignore: the gallery index is a cache of what's on disk.
    }
  }
}

interface ArtifactMetadata {
  kind: ArtifactKind;
  model: string;
  prompt: string;
  /** Shot continuity: the clip this one continues, and where in it the handoff
   * frame was taken. Both come off the durable job row, so a chain survives a
   * render that finished while the app was closed. */
  parentId?: string;
  parentHandoffSeconds?: number;
  costCredits?: number;
}

function register(file: ArtifactFile, metadata: ArtifactMetadata): StudioArtifact {
  const artifact: StudioArtifact = {
    id: file.fileName,
    kind: metadata.kind,
    path: file.path,
    fileName: file.fileName,
    bytes: file.bytes,
    model: metadata.model,
    prompt: metadata.prompt,
    createdAt: Date.now(),
    parentId: metadata.parentId,
    parentHandoffSeconds: metadata.parentHandoffSeconds,
    costCredits: metadata.costCredits,
  };
  writeIndex([artifact, ...readIndex().filter((entry) => entry.id !== artifact.id)]);
  return artifact;
}

/** Indexes a file that Rust already wrote into the gallery directory (the
 * Films watcher downloads final cuts itself; only the index entry is missing). */
export function registerDownloadedArtifact(
  file: ArtifactFile,
  metadata: ArtifactMetadata,
): StudioArtifact {
  return register(file, metadata);
}

/** Persists a base64 payload (sync image result, TTS audio) to the gallery. */
export async function saveArtifactFromBase64(
  base64: string,
  extension: string,
  metadata: ArtifactMetadata,
): Promise<StudioArtifact> {
  const file = await invoke<ArtifactFile>("carpe_diem_media_save_artifact", {
    request: { base64, extension },
  });
  return register(file, metadata);
}

/** Downloads a generated file (video, music) into the gallery through Rust —
 * the webview can't fetch cross-origin, and the download may need the key. */
export async function saveArtifactFromUrl(
  url: string,
  extension: string,
  metadata: ArtifactMetadata,
): Promise<StudioArtifact> {
  const file = await invoke<ArtifactFile>("carpe_diem_media_fetch_artifact", {
    request: { url, extension },
  });
  return register(file, metadata);
}

/** Saves a finished async job's file, whichever way the backend delivered
 * it (a download URL, or the bytes when the retrieve streamed the file). */
export async function saveArtifactFromResult(
  result: MediaFileResult,
  extension: string,
  metadata: ArtifactMetadata,
): Promise<StudioArtifact> {
  return "url" in result
    ? saveArtifactFromUrl(result.url, extension, metadata)
    : saveArtifactFromBase64(result.base64, extension, metadata);
}

/** The gallery, newest first, reconciled against what is actually on disk.
 * Paths are re-derived from the disk listing rather than trusted from the
 * stored index: on iOS the app's data container path changes across
 * reinstalls, so a persisted absolute path can go stale while the file
 * itself is still there. */
export async function listArtifacts(kind?: ArtifactKind): Promise<StudioArtifact[]> {
  const index = readIndex();
  let files: DiskArtifact[] | undefined;
  try {
    files = await invoke<DiskArtifact[]>("carpe_diem_media_list_artifacts");
  } catch {
    // If the disk listing fails, trust the index rather than showing nothing.
  }
  if (!files) {
    const sorted = [...index].sort((a, b) => b.createdAt - a.createdAt);
    return kind ? sorted.filter((entry) => entry.kind === kind) : sorted;
  }

  const byName = new Map(files.map((file) => [file.fileName, file]));
  let changed = false;
  const alive = index
    .filter((entry) => byName.has(entry.fileName))
    .map((entry) => {
      const current = byName.get(entry.fileName) as DiskArtifact;
      if (current.path === entry.path) return entry;
      changed = true;
      return { ...entry, path: current.path };
    });

  // Adopt files the index does not know about. The index is capped and can be
  // halved under quota pressure, and it is per-install — without this, a file
  // that falls out of it is still on disk, still costing space, and can never
  // be seen or deleted from the app again. Prompt and model are genuinely lost
  // (they only ever lived in the index), so say so rather than inventing them.
  const known = new Set(alive.map((entry) => entry.fileName));
  const adopted: StudioArtifact[] = files
    .filter((file) => !known.has(file.fileName))
    .map((file) => ({
      id: file.fileName,
      kind: kindFromFileName(file.fileName),
      path: file.path,
      fileName: file.fileName,
      bytes: file.bytes,
      model: "",
      prompt: "",
      createdAt: file.modifiedMs ?? Date.now(),
    }));
  if (adopted.length > 0) changed = true;

  const merged = [...alive, ...adopted].sort((a, b) => b.createdAt - a.createdAt);
  if (changed || merged.length !== index.length) writeIndex(merged);
  return kind ? merged.filter((entry) => entry.kind === kind) : merged;
}

interface DiskArtifact {
  path: string;
  fileName: string;
  bytes: number;
  modifiedMs?: number;
}

/** Best guess for a file the index lost track of. Audio collapses to "music":
 * the extension cannot tell a track from a narration, and the gallery groups
 * them the same way. */
function kindFromFileName(fileName: string): ArtifactKind {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "mp4" || ext === "webm" || ext === "mov") return "video";
  if (ext === "mp3" || ext === "wav" || ext === "m4a" || ext === "ogg") return "music";
  return "image";
}

/** Reads a gallery file back as base64 (to feed edit/upscale/i2v inputs). */
export async function readArtifactBase64(artifact: Pick<StudioArtifact, "path">): Promise<string> {
  return invoke<string>("carpe_diem_media_read_artifact", {
    request: { path: artifact.path },
  });
}

export async function deleteArtifact(artifact: StudioArtifact): Promise<void> {
  await invoke<void>("carpe_diem_media_delete_artifact", {
    request: { path: artifact.path },
  });
  writeIndex(readIndex().filter((entry) => entry.id !== artifact.id));
}

/** Copies a gallery file to a destination the user picked in a save dialog. */
export async function exportArtifact(artifact: StudioArtifact, destination: string): Promise<void> {
  await invoke<void>("carpe_diem_media_export_artifact", {
    request: { path: artifact.path, destination },
  });
}
