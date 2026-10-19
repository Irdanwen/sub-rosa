// A file from the person's own device joining the gallery, so a workflow
// step can take it: a photo, a clip or a track picked on the phone, dropped
// on the desktop. The engine reads assets from the gallery only
// (execute-node.ts), which is why an import saves first and picks second.
//
// A picture travels as one base64 string: it is small, and formats the
// operator does not read (a phone's HEIC) are re-encoded on the way. A clip
// or a track is streamed slice by slice into a staging file Rust owns
// (import-media.ts), then moved into the gallery: the webview never holds
// the whole file, which a phone could not afford for a minute of video.

import { t } from "../i18n";
import { stageMediaFile } from "../import-media";
import { saveArtifactFromBase64, saveArtifactFromStaged } from "./artifacts";
import { reencodeAsJpeg } from "./retouch/canvas-io";
import type { StudioArtifact } from "./types";

export type AssetKind = "image" | "video" | "audio";

const SENDABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Extensions a device may hand over for each kind, lower case, no dot. */
const EXTENSIONS: Record<AssetKind, readonly string[]> = {
  image: ["png", "jpg", "jpeg", "webp", "heic", "heif", "gif", "bmp", "tif", "tiff"],
  video: ["mp4", "mov", "m4v", "webm"],
  audio: ["mp3", "m4a", "wav", "flac", "aac", "ogg", "opus", "aiff", "aif", "caf"],
};

/** What a MIME type a device reports maps to, when the name has no extension. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "video/quicktime": "mov",
  "video/mp4": "mp4",
  "video/x-m4v": "m4v",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** The `accept` a file input should carry for a kind: types and, for the
 * platforms that match on extension, the extensions too. */
export function acceptFor(kind: AssetKind): string {
  const dotted = EXTENSIONS[kind].map((extension) => `.${extension}`);
  return [`${kind}/*`, ...dotted].join(",");
}

/** The extension a file should be saved under: from its name first, else
 * from the type the device reports. Undefined when neither says. */
export function assetExtension(file: Pick<File, "name" | "type">): string | undefined {
  const fromName = file.name.includes(".") ? file.name.split(".").pop()?.toLowerCase() : undefined;
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  return EXTENSION_BY_TYPE[file.type.toLowerCase()];
}

/** The kind a picked file is, by type then by extension; undefined when the
 * file is none of the three. */
export function assetKindOf(file: Pick<File, "name" | "type">): AssetKind | undefined {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  const extension = assetExtension(file);
  if (!extension) return undefined;
  for (const kind of ["image", "video", "audio"] as const) {
    if (EXTENSIONS[kind].includes(extension)) return kind;
  }
  return undefined;
}

/** What a field's kind is called when the import says what it wanted. */
export function assetNoun(kind: AssetKind): string {
  return kind === "video" ? t("a clip") : kind === "audio" ? t("a track") : t("a picture");
}

/** Read a dropped or picked image into the gallery. Formats the operator
 * does not read (a phone's HEIC) are re-encoded as JPEG on the way in. */
export async function importImageFile(file: File): Promise<StudioArtifact> {
  const read = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(t("The file could not be read.")));
    reader.readAsDataURL(file);
  });
  const native = SENDABLE_IMAGE_TYPES.has(file.type);
  const dataUrl = native ? read : await reencodeAsJpeg(read);
  const extension =
    !native || file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png";
  return saveArtifactFromBase64(dataUrl.replace(/^data:[^,]*,/, ""), extension, {
    kind: "image",
    model: "",
    prompt: "",
  });
}

/**
 * A device file joining the gallery as an asset of `kind`. A file of another
 * kind is refused before anything is read: the field said what it wanted.
 */
export async function importAssetFile(file: File, kind: AssetKind): Promise<StudioArtifact> {
  const actual = assetKindOf(file);
  if (actual !== kind) {
    throw new Error(t("This setting takes {kind}, not this file.", { kind: assetNoun(kind) }));
  }
  if (kind === "image") return importImageFile(file);
  const extension = assetExtension(file) ?? (kind === "video" ? "mp4" : "m4a");
  const stagedPath = await stageMediaFile(file);
  return saveArtifactFromStaged(stagedPath, extension, {
    // Audio goes in the music bucket, the one an audio asset's picker offers.
    kind: kind === "video" ? "video" : "music",
    model: "",
    prompt: "",
  });
}
