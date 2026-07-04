// Studio gallery: generated files live on disk (via the Rust artifact
// commands), the index lives in localStorage. Keeping bytes out of
// localStorage means the gallery survives restarts without quota pressure;
// reconciling against the disk on load drops entries whose file is gone.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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
  };
  writeIndex([artifact, ...readIndex().filter((entry) => entry.id !== artifact.id)]);
  return artifact;
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

/** The gallery, newest first, reconciled against what is actually on disk. */
export async function listArtifacts(kind?: ArtifactKind): Promise<StudioArtifact[]> {
  const index = readIndex();
  let onDisk: Set<string> | undefined;
  try {
    const files = await invoke<Array<{ fileName: string }>>("carpe_diem_media_list_artifacts");
    onDisk = new Set(files.map((file) => file.fileName));
  } catch {
    // If the disk listing fails, trust the index rather than showing nothing.
  }
  const alive = onDisk ? index.filter((entry) => onDisk.has(entry.fileName)) : index;
  if (alive.length !== index.length) writeIndex(alive);
  const sorted = [...alive].sort((a, b) => b.createdAt - a.createdAt);
  return kind ? sorted.filter((entry) => entry.kind === kind) : sorted;
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
