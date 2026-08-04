// Reference-image intake for the film studio: read a picked file into the
// original base64 (uploaded to the studio untouched) plus a downscaled
// preview data URI (form thumbnail + what the brief improver analyzes, so a
// 20 MB photo never rides a chat-completions payload).

import type { FilmBriefRef, FilmRefRole } from "./index";

const PREVIEW_MAX_EDGE = 1024;
const PREVIEW_QUALITY = 0.85;

export async function readFilmRef(file: File, role: FilmRefRole): Promise<FilmBriefRef> {
  return buildFilmRef(await readAsDataUri(file), file.name || "reference.png", role);
}

/**
 * The same intake for an image already in hand as a data URI - a pick from the
 * studio library rather than a file the user just chose. Shares the body with
 * {@link readFilmRef} so a library reference and an uploaded one are the same
 * thing downstream: same downscaled preview for the improver, same untouched
 * original for the upload.
 */
export async function buildFilmRef(
  dataUri: string,
  fileName: string,
  role: FilmRefRole,
): Promise<FilmBriefRef> {
  const base64Data = dataUri.replace(/^data:[^,]*,/, "");
  // Downscaling is best-effort: a decode failure falls back to the original
  // (the Rust side caps oversized previews instead of failing the improve).
  const previewDataUri = await downscale(dataUri).catch(() => dataUri);
  return {
    id: crypto.randomUUID(),
    role,
    label: "",
    fileName: fileName || "reference.png",
    base64Data,
    previewDataUri,
  };
}

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

function downscale(dataUri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const edge = Math.max(image.naturalWidth, image.naturalHeight);
      if (!edge || edge <= PREVIEW_MAX_EDGE) {
        resolve(dataUri);
        return;
      }
      const scale = PREVIEW_MAX_EDGE / edge;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(dataUri);
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", PREVIEW_QUALITY));
    };
    image.onerror = () => reject(new Error("Could not decode the image."));
    image.src = dataUri;
  });
}
