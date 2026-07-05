import { MediaError, mediaJson, mediaRaw } from "./client";

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

/** Async queue path: JSON while pending, raw image bytes once done. */
async function generateViaQueue(body: Record<string, unknown>): Promise<string[]> {
  const queued = await mediaJson<Record<string, unknown>>("/image/generate/queue", body);
  const queueId = queued.queue_id ?? queued.id;
  if (typeof queueId !== "string" || !queueId) {
    throw new MediaError("The backend did not return a job id.", { status: 200 });
  }
  for (let attempt = 0; attempt < IMAGE_QUEUE_MAX_ATTEMPTS; attempt += 1) {
    const response = await mediaRaw("/image/generate/retrieve", { queue_id: queueId });
    if (response.bodyBase64) return [response.bodyBase64];
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
