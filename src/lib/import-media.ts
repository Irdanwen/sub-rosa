// Turning a file the user already has into a note.
//
// The Rust side decodes whatever container arrives (ADR-0026), so the only
// job here is getting the bytes across without holding a recording in the
// webview's memory. A file dropped on the window is a `File` with no path —
// the window runs with `dragDropEnabled: false` so the agent composer keeps
// its own drop handling — and on iOS even a picked file is unreachable from
// Rust. Both are solved the same way: slice the file and let Rust stage it.
//
// The file picker on desktop is still the better path when it is available,
// because a path costs nothing at all.

import { discardStagedImport, importAudioNote, type NoteDto, stageImportedFile } from "./tauri";

/** Containers `import_audio_note` accepts. Mirrors
 * `IMPORTABLE_AUDIO_EXTENSIONS` in `src-tauri/src/commands.rs`; a value here
 * that is missing there fails late, with a worse message. */
export const IMPORTABLE_MEDIA_EXTENSIONS = [
  "aac",
  "aif",
  "aiff",
  "caf",
  "flac",
  "m4a",
  "m4b",
  "m4v",
  "mka",
  "mov",
  "mp3",
  "mp4",
  "mpga",
  "oga",
  "ogg",
  "ogv",
  "opus",
  "wav",
  "webm",
] as const;

/** For an `<input type="file">` accept attribute. */
export const IMPORTABLE_MEDIA_ACCEPT = IMPORTABLE_MEDIA_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(",");

/** 8 MB of file per slice: about 11 MB of base64 in flight, which every
 * platform holds comfortably, and few enough round trips that a two-hour
 * video is a few hundred calls rather than a few thousand. */
const SLICE_BYTES = 8 * 1024 * 1024;

export function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  return match ? match[1].toLowerCase() : "";
}

export function isImportableMediaFile(fileName: string): boolean {
  return (IMPORTABLE_MEDIA_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));
}

function base64FromBytes(bytes: Uint8Array): string {
  // Chunked so the spread never blows the argument limit on a large slice.
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function newUploadId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random.replace(/[^A-Za-z0-9-]/g, "");
  return `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type StageProgress = {
  /** Bytes handed over so far. */
  transferred: number;
  total: number;
};

/**
 * Stream `file` into a staging file Rust owns and return its path.
 *
 * Slice by slice on purpose: reading a two-hour video into one `ArrayBuffer`
 * takes the webview down long before Rust ever sees it.
 */
export async function stageMediaFile(
  file: File,
  onProgress?: (progress: StageProgress) => void,
): Promise<string> {
  const uploadId = newUploadId();
  const fileName = file.name;
  try {
    let transferred = 0;
    let staged: string | null = null;
    // A zero-byte file still needs one call, so `done` can come back with a
    // path instead of the loop never running.
    do {
      const slice = file.slice(transferred, transferred + SLICE_BYTES);
      const bytes = new Uint8Array(await slice.arrayBuffer());
      transferred += bytes.length;
      const done = transferred >= file.size;
      staged = await stageImportedFile({
        uploadId,
        fileName,
        base64: base64FromBytes(bytes),
        done,
      });
      onProgress?.({ transferred, total: file.size });
    } while (!staged);
    return staged;
  } catch (error) {
    // A half-written staging file is dead weight on the user's disk. Cleaning
    // it up must never replace the failure the caller needs to see, so the
    // cleanup's own failure is swallowed whole.
    try {
      await discardStagedImport(uploadId, fileName);
    } catch {
      // Nothing to do: the temp directory is the OS's problem from here.
    }
    throw error;
  }
}

/** Stage `file` and turn it into a note. */
export async function importMediaFile(
  file: File,
  options: { folderId?: string; onProgress?: (progress: StageProgress) => void } = {},
): Promise<NoteDto> {
  const stagedPath = await stageMediaFile(file, options.onProgress);
  return importAudioNote({ stagedPath, fileName: file.name, folderId: options.folderId });
}

/** Import a file already on disk, by path. Desktop only — nothing is copied
 * through the webview at all. */
export async function importMediaPath(
  sourcePath: string,
  options: { folderId?: string } = {},
): Promise<NoteDto> {
  const fileName = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
  return importAudioNote({ sourcePath, fileName, folderId: options.folderId });
}

/** Media files out of a drag-and-drop payload, ignoring anything else that
 * came along. */
export function importableFilesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return Array.from(transfer.files).filter((file) => isImportableMediaFile(file.name));
}
