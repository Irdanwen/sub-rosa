import { MediaError, mediaJson, mediaRaw } from "./client";
import type { MediaModel } from "./types";

/** Models whose sync path exceeds the edge cap: queue from the start. */
const HEAVY_IMAGE_MODELS = ["gpt-image", "nano-banana-pro", "recraft-v4-pro"];

const IMAGE_QUEUE_POLL_MS = 3_000;
const IMAGE_QUEUE_MAX_ATTEMPTS = 100;

export function isHeavyImageModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return HEAVY_IMAGE_MODELS.some((prefix) => id.includes(prefix));
}

interface GenerateResponse {
  images?: Array<string | { b64_json?: string }>;
}

function imagesFromResponse(response: GenerateResponse): string[] {
  return (response.images ?? [])
    .map((image) => (typeof image === "string" ? image : (image.b64_json ?? "")))
    .filter((image) => image.trim().length > 0);
}

/** Clamp a requested variant count to the API's documented 1–4 range. */
function normalizeVariants(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(4, Math.floor(n));
}

/**
 * Submit one queue job and poll until it yields an image. `retrieve` returns
 * JSON while pending and raw image bytes once done.
 */
async function runQueueJob(body: Record<string, unknown>): Promise<string> {
  const queued = await mediaJson<Record<string, unknown>>("/image/generate/queue", body);
  const queueId = queued.queue_id ?? queued.id;
  if (typeof queueId !== "string" || !queueId) {
    throw new MediaError("The backend did not return a job id.", { status: 200 });
  }
  for (let attempt = 0; attempt < IMAGE_QUEUE_MAX_ATTEMPTS; attempt += 1) {
    const response = await mediaRaw("/image/generate/retrieve", { queue_id: queueId });
    if (response.bodyBase64) return response.bodyBase64;
    const json = response.json as Record<string, unknown> | undefined;
    const status = typeof json?.status === "string" ? json.status.toLowerCase() : "";
    if (status === "failed" || status === "error") {
      const reason = typeof json?.error === "string" ? json.error : "The generation failed.";
      throw new MediaError(reason, { status: 200 });
    }
    await new Promise((resolve) => setTimeout(resolve, IMAGE_QUEUE_POLL_MS));
  }
  throw new MediaError("The image is taking longer than expected. Try again later.", {
    status: 0,
  });
}

/**
 * Async queue path. Unlike the sync endpoint, `retrieve` returns exactly one
 * image per job, so `variants` has to be fanned out into one queue job per
 * variant instead of expanded server-side. Jobs run concurrently; a fixed seed
 * is offset per job so the variants differ instead of collapsing to the same
 * image (an unset seed defaults to random per job, so those differ naturally).
 * Partial success returns whatever completed — the async path bills only on
 * retrievable success, so we never discard paid images over one failed sibling.
 */
async function generateViaQueue(body: Record<string, unknown>): Promise<string[]> {
  const variants = normalizeVariants(body.variants);
  if (variants <= 1) {
    return [await runQueueJob(body)];
  }
  const seed = typeof body.seed === "number" && Number.isFinite(body.seed) ? body.seed : undefined;
  const settled = await Promise.allSettled(
    Array.from({ length: variants }, (_unused, index) => {
      const jobBody: Record<string, unknown> = { ...body, variants: 1 };
      if (seed !== undefined) jobBody.seed = seed + index;
      return runQueueJob(jobBody);
    }),
  );
  const images = settled
    .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
    .map((result) => result.value);
  if (images.length === 0) {
    const rejection = settled.find((result) => result.status === "rejected");
    throw (
      (rejection as PromiseRejectedResult | undefined)?.reason ??
      new MediaError("The generation failed.", { status: 200 })
    );
  }
  // Partial success is fine: the async path bills only on retrievable success,
  // so we return whatever completed rather than discard paid images.
  return images;
}

export interface CompareGenerateOptions {
  negativePrompt?: string;
  seed?: number;
  aspectRatio?: string;
}

/**
 * One request body per model for a side-by-side comparison run: the same
 * prompt everywhere, one image each, and only the settings a given model
 * supports (the aspect ratio is dropped for models that don't offer the
 * chosen one instead of failing that model's render).
 */
export function compareBodies(
  models: MediaModel[],
  prompt: string,
  options: CompareGenerateOptions = {},
): Array<{ model: MediaModel; body: Record<string, unknown> }> {
  const seen = new Set<string>();
  const unique = models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  return unique.map((model) => {
    const body: Record<string, unknown> = {
      model: model.id,
      prompt,
      variants: 1,
      format: "png",
      hide_watermark: true,
      safe_mode: false,
    };
    if (options.negativePrompt?.trim()) body.negative_prompt = options.negativePrompt.trim();
    if (options.seed !== undefined && Number.isFinite(options.seed)) body.seed = options.seed;
    const aspects = model.constraints?.aspectRatios ?? [];
    if (options.aspectRatio && aspects.includes(options.aspectRatio)) {
      body.aspect_ratio = options.aspectRatio;
    }
    return { model, body };
  });
}

/**
 * Generate images for a `/image/generate` request body, routing heavy models
 * through the async queue and retrying the sync path through the queue when
 * the edge cap 502s. Returns base64 image payloads. Shared by the desktop
 * ImageStudio and the mobile Studio screen.
 */
export async function generateImages(
  modelId: string,
  body: Record<string, unknown>,
): Promise<string[]> {
  if (isHeavyImageModel(modelId)) {
    return generateViaQueue(body);
  }
  try {
    return imagesFromResponse(await mediaJson<GenerateResponse>("/image/generate", body));
  } catch (syncError) {
    // A 502 on a sync call is usually the edge cap, not a failure: the async
    // path renders the same request without the cap.
    if (syncError instanceof MediaError && syncError.status === 502) {
      return generateViaQueue(body);
    }
    throw syncError;
  }
}
