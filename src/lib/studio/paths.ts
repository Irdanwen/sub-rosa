// Backend endpoint differences. Carpe Diem proxies Venice verbatim for most
// media surfaces, but music lives under `/audio/music/*` there (vs `/audio/*`
// on Venice), and its retrieve endpoints demand `model` next to the job id.
//
// Retrieve bodies send a superset (`id` + `queue_id` + `model`): Venice reads
// `id`, Carpe Diem reads `queue_id` + `model`, and both tolerate the extras.
// One shape means persisted jobs replay correctly on either backend.

export type MediaBackend = "carpe-diem" | "venice";

export interface MusicPaths {
  queue: string;
  retrieve: string;
}

export function musicPaths(backend: MediaBackend): MusicPaths {
  if (backend === "carpe-diem") {
    return { queue: "/audio/music/queue", retrieve: "/audio/music/retrieve" };
  }
  return { queue: "/audio/queue", retrieve: "/audio/retrieve" };
}

export const VIDEO_QUEUE_PATH = "/video/queue";
export const VIDEO_RETRIEVE_PATH = "/video/retrieve";
export const VIDEO_QUOTE_PATH = "/video/quote";

export function retrieveBody(queueId: string, model: string): Record<string, unknown> {
  return { id: queueId, queue_id: queueId, model };
}

/** `/video/quote` 400s on some families even with a valid payload — skip the
 * quote for those and queue directly. The video-to-video and video-upscale
 * families reject every quote probe (2026-07-20), like ltx always has. */
export function supportsVideoQuote(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.startsWith("ltx")) return false;
  return !(id.includes("video-to-video") || id.includes("video-upscale"));
}
