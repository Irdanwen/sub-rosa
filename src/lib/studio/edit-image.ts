import { MediaError, mediaJson, mediaRaw } from "./client";

const EDIT_QUEUE_POLL_MS = 3_000;
const EDIT_QUEUE_MAX_ATTEMPTS = 100;

/** Models whose edits exceed the sync edge cap: queue from the start. */
const HEAVY_EDIT_MODELS = ["gpt-image", "nano-banana-pro"];

function isHeavyEditModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return HEAVY_EDIT_MODELS.some((prefix) => id.includes(prefix));
}

async function editViaQueue(body: Record<string, unknown>): Promise<string> {
  const queued = await mediaJson<Record<string, unknown>>("/image/edit/queue", body);
  const queueId = queued.queue_id ?? queued.id;
  if (typeof queueId !== "string" || !queueId) {
    throw new MediaError("The backend did not return a job id.", { status: 200 });
  }
  for (let attempt = 0; attempt < EDIT_QUEUE_MAX_ATTEMPTS; attempt += 1) {
    const response = await mediaRaw("/image/edit/retrieve", {
      id: queueId,
      queue_id: queueId,
      model: body.model,
    });
    if (response.bodyBase64) return response.bodyBase64;
    const json = response.json as Record<string, unknown> | undefined;
    const status = typeof json?.status === "string" ? json.status.toLowerCase() : "";
    if (status === "failed" || status === "error") {
      const reason = typeof json?.error === "string" ? json.error : "The edit failed.";
      throw new MediaError(reason, { status: 200 });
    }
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
  const body: Record<string, unknown> = { model: modelId, prompt, image: imageDataUri };
  if (isHeavyEditModel(modelId)) {
    return editViaQueue(body);
  }
  try {
    const response = await mediaRaw("/image/edit", body);
    if (!response.ok || !response.bodyBase64) {
      throw new MediaError("The edit did not return an image.", { status: response.status });
    }
    return response.bodyBase64;
  } catch (syncError) {
    if (
      syncError instanceof MediaError &&
      (syncError.status === 502 || /queue|synchronous/i.test(syncError.message))
    ) {
      return editViaQueue(body);
    }
    throw syncError;
  }
}

/** Upscale a gallery image (raw base64 in, base64 out, scale 2 to 4). */
export async function upscaleImage(base64: string, scale: 2 | 3 | 4): Promise<string> {
  const response = await mediaRaw("/image/upscale", { image: base64, scale });
  if (!response.ok || !response.bodyBase64) {
    throw new MediaError("The upscale did not return an image.", { status: response.status });
  }
  return response.bodyBase64;
}
