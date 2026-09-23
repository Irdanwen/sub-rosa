import { t } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readArtifactBase64 } from "./artifacts";
import { isAsyncRetrySignal, MediaError, mediaRaw } from "./client";
import type { MediaProxyResponse } from "./types";

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

interface NativeImageJob {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  error?: string;
  artifactPath?: string;
}

/** Native owns the request and durable polling. Subscribe before queueing so
 * an immediate completion cannot race the listener. On restart the ordinary
 * gallery job reconciliation recovers results without queueing a second edit. */
export async function nativeQueuedImage(
  base: string,
  body: Record<string, unknown>,
): Promise<string> {
  const jobId = crypto.randomUUID();
  let resolveJob: (job: NativeImageJob) => void = () => {};
  const done = new Promise<NativeImageJob>((resolve) => {
    resolveJob = resolve;
  });
  const observe = (job: NativeImageJob) => {
    if (job.id === jobId && (job.status === "completed" || job.status === "failed"))
      resolveJob(job);
  };
  const unlisten = await listen<NativeImageJob>("june://media-job", (event) =>
    observe(event.payload),
  );
  try {
    const submitted = await invoke<NativeImageJob>("media_job_queue", {
      request: {
        jobId,
        kind: "image",
        model: body.model,
        prompt: body.prompt,
        extension: "png",
        queuePath: `${base}/queue`,
        queueBody: body,
        retrievePath: `${base}/retrieve`,
        urlFields: ["image_url", "url"],
        source: "studio",
      },
    });
    observe(submitted);
    const job = await done;
    if (job.status === "failed")
      throw new MediaError(job.error ?? "The edit failed.", { status: 0 });
    if (!job.artifactPath)
      throw new MediaError(t("The edit finished but its file is missing."), { status: 0 });
    return readArtifactBase64({ path: job.artifactPath });
  } catch (error) {
    if (
      !(error instanceof Error) &&
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    )
      throw new Error(t(error.message));
    throw error;
  } finally {
    unlisten();
  }
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
    return nativeQueuedImage("/image/edit", body);
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
      return nativeQueuedImage("/image/edit", body);
    }
    throw syncError;
  }
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
  const images = imageDataUris.filter((uri) => uri.trim());
  if (images.length > MAX_COMPOSE_IMAGES)
    throw new MediaError(t("Choose at most three reference images."), { status: 0 });
  if (images.length === 0) {
    throw new MediaError("Add at least one image to compose.", { status: 0 });
  }
  if (images.length === 1) {
    return editImage(modelId, prompt, images[0]);
  }
  return nativeQueuedImage("/image/multi-edit", {
    model: modelId,
    prompt,
    images,
    safe_mode: false,
  });
}

/**
 * Produce a transparent cutout (binary `image/png` with alpha) via Venice's
 * dedicated `/image/background-remove` endpoint. Accepts a data URI or raw
 * base64 (the endpoint wants plain base64). Venice-only today: the Carpe Diem
 * operator's catalog lists `bria-bg-remover` but no route accepts it (probed
 * 2026-07-20: `/image/background-remove` 404s, edit and generate reject the
 * model id) — gate callers with `supportsBackgroundRemoval`.
 */
export async function removeBackground(imageDataUriOrBase64: string): Promise<string> {
  const image = imageDataUriOrBase64.replace(/^data:[^,]*,/, "");
  const response = await mediaRaw("/image/background-remove", { image });
  if (!response.ok || !response.bodyBase64) {
    throw new MediaError("The cutout did not return an image.", { status: response.status });
  }
  return response.bodyBase64;
}

/** Upscale a gallery image (raw base64 in, base64 out, scale 2 to 4). */
export async function upscaleImage(base64: string, scale: 2 | 3 | 4): Promise<string> {
  const response = await mediaRaw("/image/upscale", { image: base64, scale });
  if (!response.ok || !response.bodyBase64) {
    throw new MediaError("The upscale did not return an image.", { status: response.status });
  }
  return response.bodyBase64;
}
