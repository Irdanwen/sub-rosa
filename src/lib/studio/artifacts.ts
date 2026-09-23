// Studio gallery: generated files live on disk (via the Rust artifact
// commands), the index lives in localStorage. Keeping bytes out of
// localStorage means the gallery survives restarts without quota pressure;
// reconciling against the disk on load drops entries whose file is gone.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { MediaFileResult } from "./async-job";
import type { ArtifactFile, ArtifactKind, StudioArtifact } from "./types";

const GALLERY_STORAGE_KEY = "os-june:studio-gallery";
const MAX_GALLERY_ENTRIES = 200;
/** Queue renders already have a gallery file. Hold only the small number of
 * images currently being handed to consumers, then reuse that file when the
 * consumer records its generation metadata. */
const queuedImages = new Map<
  string,
  Array<{ file: ArtifactFile; jobId: string; source: string }>
>();
const MAX_QUEUED_IMAGES = 16;
let queuedImageCount = 0;
const claimedImageJobs = new Set<string>();
const attachingBibleJobs = new Map<string, string>();

export function claimQueuedImageJob(jobId: string): void {
  claimedImageJobs.add(jobId);
}

export function releaseQueuedImageJob(jobId: string): void {
  claimedImageJobs.delete(jobId);
}

export function isQueuedImageJobClaimed(jobId: string): boolean {
  return claimedImageJobs.has(jobId);
}

export function rememberQueuedImage(
  base64: string,
  file: ArtifactFile,
  jobId: string,
  source = "studio",
): void {
  const files = queuedImages.get(base64) ?? [];
  files.push({ file, jobId, source });
  queuedImages.set(base64, files);
  queuedImageCount += 1;
  while (queuedImageCount > MAX_QUEUED_IMAGES) {
    const oldest = queuedImages.keys().next().value as string;
    const remaining = queuedImages.get(oldest);
    const evicted = remaining?.shift();
    if (evicted) releaseQueuedImageJob(evicted.jobId);
    queuedImageCount -= 1;
    if (!remaining?.length) queuedImages.delete(oldest);
  }
}

/** A bible job stays durable until its reference has also been attached. */
export async function finishQueuedBibleImage(artifactId: string, attached: boolean): Promise<void> {
  const jobId = attachingBibleJobs.get(artifactId);
  if (!jobId) return;
  attachingBibleJobs.delete(artifactId);
  if (attached) await invoke("media_job_dismiss", { id: jobId }).catch(() => undefined);
  releaseQueuedImageJob(jobId);
}

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
  /** Frame capture provenance: the clip the still came out of, and where in
   * it. Kept apart from the chain fields above - see `StudioArtifact`. */
  sourceArtifactId?: string;
  sourceTimeSeconds?: number;
  costCredits?: number;
}

function register(
  file: ArtifactFile,
  metadata: ArtifactMetadata,
): { artifact: StudioArtifact; persisted: Promise<void> } {
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
    sourceArtifactId: metadata.sourceArtifactId,
    sourceTimeSeconds: metadata.sourceTimeSeconds,
    costCredits: metadata.costCredits,
  };
  writeIndex([artifact, ...readIndex().filter((entry) => entry.id !== artifact.id)]);
  const { path: _path, ...generation } = artifact;
  const persisted = invoke("studio_artifact_save", {
    request: { id: artifact.id, generation },
  }).then(() => undefined);
  void persisted.catch(() => undefined);
  return { artifact, persisted };
}

/** Indexes a file that Rust already wrote into the gallery directory (the
 * Films watcher downloads final cuts itself; only the index entry is missing). */
export function registerDownloadedArtifact(
  file: ArtifactFile,
  metadata: ArtifactMetadata,
): StudioArtifact {
  return register(file, metadata).artifact;
}

/** Keep a native job until its generation metadata has committed as well. */
export async function registerDownloadedArtifactDurably(
  file: ArtifactFile,
  metadata: ArtifactMetadata,
): Promise<StudioArtifact> {
  const { artifact, persisted } = register(file, metadata);
  await persisted;
  return artifact;
}

/** Persists a base64 payload (sync image result, TTS audio) to the gallery. */
export async function saveArtifactFromBase64(
  base64: string,
  extension: string,
  metadata: ArtifactMetadata,
): Promise<StudioArtifact> {
  const files = queuedImages.get(base64);
  const queued = files?.shift();
  if (queued) {
    queuedImageCount -= 1;
    if (!files?.length) queuedImages.delete(base64);
    const { artifact, persisted } = register(queued.file, metadata);
    try {
      await persisted;
    } catch (error) {
      releaseQueuedImageJob(queued.jobId);
      throw error;
    }
    if (queued.source.startsWith("bible-ref:")) {
      attachingBibleJobs.set(artifact.id, queued.jobId);
    } else {
      await invoke("media_job_dismiss", { id: queued.jobId }).catch(() => undefined);
      releaseQueuedImageJob(queued.jobId);
    }
    return artifact;
  }
  const file = await invoke<ArtifactFile>("carpe_diem_media_save_artifact", {
    request: { base64, extension },
  });
  return register(file, metadata).artifact;
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
  return register(file, metadata).artifact;
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
  const legacy = readIndex();
  let durable: Array<{
    id: string;
    title: string;
    projectIds: string[];
    generation?: Partial<StudioArtifact>;
  }> = [];
  try {
    durable = (await invoke<typeof durable>("studio_artifact_list")) ?? [];
    const known = new Map(durable.map((entry, index) => [entry.id, index]));
    for (const artifact of legacy) {
      const index = known.get(artifact.id);
      const current = index === undefined ? undefined : durable[index];
      if (current?.generation) continue;
      const { path: _path, ...generation } = artifact;
      const migrated = await invoke<(typeof durable)[number]>("studio_artifact_save", {
        request: {
          id: artifact.id,
          title: current?.title || artifact.title || "",
          projectIds: current?.projectIds ?? artifact.projectIds ?? [],
          generation,
        },
      });
      if (index === undefined) {
        known.set(artifact.id, durable.length);
        durable.push(migrated);
      } else {
        durable[index] = migrated;
      }
    }
  } catch {
    /* Older shells retain the legacy gallery path. */
  }
  const entries = new Map(legacy.map((entry) => [entry.id, entry]));
  for (const metadata of durable) {
    const previous = entries.get(metadata.id);
    if (!previous && !metadata.generation?.fileName) continue;
    entries.set(metadata.id, {
      ...previous,
      ...metadata.generation,
      id: metadata.id,
      path: previous?.path ?? "",
      title: metadata.title,
      projectIds: metadata.projectIds,
    } as StudioArtifact);
  }
  const index = [...entries.values()];
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
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac", "opus"].includes(ext)) return "music";
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

/**
 * Copies a gallery file where the user chooses. Rust opens the save dialog, so
 * no destination crosses IPC. Resolves to the saved path, or `null` if the user
 * cancelled.
 */
export async function exportArtifact(artifact: StudioArtifact): Promise<string | null> {
  return invoke<string | null>("carpe_diem_media_export_artifact", {
    request: { path: artifact.path, suggestedName: artifact.fileName },
  });
}
