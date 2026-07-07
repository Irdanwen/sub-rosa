import { MediaError, mediaJson, mediaRaw } from "./client";
import type { MediaProxyResponse } from "./types";

const EDIT_QUEUE_POLL_MS = 3_000;
const EDIT_QUEUE_MAX_ATTEMPTS = 100;

/** Carpe Diem's multi-edit endpoint composes 1 to 3 source images. */
export const MAX_COMPOSE_IMAGES = 3;

/** Models whose edits exceed the sync edge cap: queue from the start. */
const HEAVY_EDIT_MODELS = ["gpt-image", "nano-banana-pro"];

function isHeavyEditModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return HEAVY_EDIT_MODELS.some((prefix) => id.includes(prefix));
}

/** The edit endpoint returns raw image bytes for most models but a Venice-style
 * JSON envelope (`{images: [b64]}`) for some (e.g. `qwen-edit-uncensored`).
 * Accept both; return undefined while a queue job is still pending. */
function imageFromEditResponse(response: MediaProxyResponse): string | undefined {
  if (response.bodyBase64) return response.bodyBase64;
  const json = response.json as { images?: Array<string | { b64_json?: string }> } | undefined;
  const first = json?.images?.[0];
  if (typeof first === "string" && first.trim()) return first;
  if (first && typeof first === "object" && first.b64_json?.trim()) return first.b64_json;
  return undefined;
}

/** Queue an edit/compose job and poll it to a rendered image. `base` is the
 * endpoint stem: `/image/edit` for a single-image edit, `/image/multi-edit`
 * for a composition — both share the queue/retrieve/response shape. */
async function editViaQueue(base: string, body: Record<string, unknown>): Promise<string> {
  const queued = await mediaJson<Record<string, unknown>>(`${base}/queue`, body);
  const queueId = queued.queue_id ?? queued.id;
  if (typeof queueId !== "string" || !queueId) {
    throw new MediaError("The backend did not return a job id.", { status: 200 });
  }
  for (let attempt = 0; attempt < EDIT_QUEUE_MAX_ATTEMPTS; attempt += 1) {
    const response = await mediaRaw(`${base}/retrieve`, {
      id: queueId,
      queue_id: queueId,
      model: body.model,
    });
    const json = response.json as Record<string, unknown> | undefined;
    const status = typeof json?.status === "string" ? json.status.toLowerCase() : "";
    if (status === "failed" || status === "error") {
      const reason = typeof json?.error === "string" ? json.error : "The edit failed.";
      throw new MediaError(reason, { status: 200 });
    }
    const image = imageFromEditResponse(response);
    if (image) return image;
    await new Promise((resolve) => setTimeout(resolve, EDIT_QUEUE_POLL_MS));
  }
  throw new MediaError("The edit is taking longer than expected. Try again later.", {
    status: 0,
  });
}

/**
 * Edit an image (`image` is a data URI). Heavy models queue directly; sync
 * requests that bounce off the edge cap (502, or the backend's explicit
 * "use the async queue" rejection) retry through the queue.
 */
export async function editImage(
  modelId: string,
  prompt: string,
  imageDataUri: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: modelId,
    prompt,
    image: imageDataUri,
    safe_mode: false,
  };
  if (isHeavyEditModel(modelId)) {
    return editViaQueue("/image/edit", body);
  }
  try {
    const response = await mediaRaw("/image/edit", body);
    const image = imageFromEditResponse(response);
    if (!response.ok || !image) {
      throw new MediaError("The edit did not return an image.", { status: response.status });
    }
    return image;
  } catch (syncError) {
    if (isAsyncRetrySignal(syncError)) {
      return editViaQueue("/image/edit", body);
    }
    throw syncError;
  }
}

/** A sync edit/compose that the backend wants run through its async queue: the
 * edge cap 502s, or the backend answers `MODEL_REQUIRES_ASYNC` / a "use the
 * queue" message. */
function isAsyncRetrySignal(error: unknown): boolean {
  return (
    error instanceof MediaError &&
    (error.status === 502 ||
      error.status === 409 ||
      error.code === "MODEL_REQUIRES_ASYNC" ||
      /queue|synchronous|async/i.test(error.message))
  );
}

/**
 * Compose several source images into one, driven by a prompt (Carpe Diem's
 * `/image/multi-edit`). Accepts 1 to {@link MAX_COMPOSE_IMAGES} data URIs; a
 * single image degrades to a plain {@link editImage}. The multi-capable models
 * are all heavy, so compositions always go through the async queue.
 */
export async function composeImages(
  modelId: string,
  prompt: string,
  imageDataUris: string[],
): Promise<string> {
  const images = imageDataUris.filter((uri) => uri.trim()).slice(0, MAX_COMPOSE_IMAGES);
  if (images.length === 0) {
    throw new MediaError("Add at least one image to compose.", { status: 0 });
  }
  if (images.length === 1) {
    return editImage(modelId, prompt, images[0]);
  }
  return editViaQueue("/image/multi-edit", { model: modelId, prompt, images, safe_mode: false });
}

/** Upscale a gallery image (raw base64 in, base64 out, scale 2 to 4). */
export async function upscaleImage(base64: string, scale: 2 | 3 | 4): Promise<string> {
  const response = await mediaRaw("/image/upscale", { image: base64, scale });
  if (!response.ok || !response.bodyBase64) {
    throw new MediaError("The upscale did not return an image.", { status: response.status });
  }
  return response.bodyBase64;
}
