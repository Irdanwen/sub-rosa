/**
 * Pictures from the browser: generate, edit, compose (try-on) and refine,
 * through Carpe Diem's image routes with the browser device's bounded key
 * (ADR-0096 lets it reach `/v1/image/*`). The requests are the app's
 * (`src/lib/studio/`): the same bodies, the queue for heavy models and as the
 * fallback when the quick route says so, one picture per job.
 *
 * A browser has no durable job runner (ADR-0018 is the phone's answer to a
 * suspended process): a queued job is polled while the tab is open, and its
 * queue id is kept (`pending`) so a reload picks the same job up again
 * instead of paying for a second one.
 */
import { tryOnPrompt, TRY_ON_MODEL_PREFERENCE } from "@subrosa/chat-core/try-on";
import snapshotData from "../models/snapshot.json";
import { CarpeDiemError, type LiveModel, type Operator } from "./carpe-diem";
import { AGENT_LITE } from "./codec";

export interface ImageModel {
  id: string;
  name: string;
  credits?: number;
  privacy?: string;
}

interface SnapshotModel {
  id: string;
  type: string;
  name?: string;
  credits?: number;
  privacy?: string;
}
const snapshot = (snapshotData as { models: SnapshotModel[] }).models;

/** Generation and edit models: the published catalog, minus what Carpe Diem
 * no longer lists today. */
export function imageModels(type: "image" | "imageEdit", live: LiveModel[] = []): ImageModel[] {
  const listed = new Set(live.map((model) => model.id));
  return snapshot
    .filter((model) => model.type === type && model.id !== "bria-bg-remover")
    .filter((model) => !live.length || listed.has(model.id))
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      credits: model.credits,
      privacy: model.privacy,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The try-on model: the app's preference among the edit models listed. */
export function tryOnModel(models: ImageModel[]): ImageModel | undefined {
  for (const preferred of TRY_ON_MODEL_PREFERENCE) {
    const hit = models.find((model) => model.id.toLowerCase() === preferred);
    if (hit) return hit;
  }
  return undefined;
}

/** The refine pass's edit model: the requested one, else the app's
 * preference, else the cheapest. */
export function refineEditModel(models: ImageModel[], requested?: string): ImageModel | undefined {
  if (requested) {
    const hit = models.find((model) => model.id === requested);
    if (hit) return hit;
  }
  for (const preferred of AGENT_LITE.editing.refine.editModels) {
    const hit = models.find((model) => model.id === preferred);
    if (hit) return hit;
  }
  return [...models].sort((a, b) => (a.credits ?? Infinity) - (b.credits ?? Infinity))[0];
}

const HEAVY_IMAGE_MODELS = ["gpt-image", "nano-banana-pro", "recraft-v4-pro", "qwen-image-3-pro"];
const HEAVY_EDIT_MODELS = ["gpt-image", "nano-banana-pro"];
const heavy = (list: string[], id: string) =>
  list.some((prefix) => id.toLowerCase().includes(prefix));

/** What to keep of a queued job so a reload can resume polling it. */
export interface PendingJob {
  queueId: string;
  base: "/v1/image/generate" | "/v1/image/edit" | "/v1/image/multi-edit";
  model: string;
  prompt: string;
}
export interface JobKeeper {
  keep(job: PendingJob): Promise<void> | void;
  done(queueId: string): Promise<void> | void;
}
const NO_KEEPER: JobKeeper = { keep: () => undefined, done: () => undefined };

export interface ImageCall {
  operator: Operator;
  key: string;
  signal?: AbortSignal;
  keeper?: JobKeeper;
  /** Poll spacing and limit; tests shorten them. */
  pollMs?: number;
  waitMs?: number;
}

/** An image the operator answered with: a PNG/JPEG/WebP as a data URL. */
export type Picture = { dataUrl: string; model: string; prompt: string };

async function failure(response: Response): Promise<CarpeDiemError> {
  let code = "carpe_diem_unavailable";
  let message = `Carpe Diem answered ${response.status}.`;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.code === "string") code = body.code;
    if (typeof body.error === "string") message = body.error;
    else if (typeof body.message === "string") message = body.message;
  } catch {
    // The status says enough.
  }
  return new CarpeDiemError(code, response.status, message);
}

function post(call: ImageCall, path: string, body: unknown): Promise<Response> {
  return call.operator.fetch(`${call.operator.root}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${call.key}`,
      "Content-Type": "application/json",
      Accept: "application/json, image/*",
    },
    body: JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: call.signal,
  });
}

function isAsyncRetrySignal(error: unknown): boolean {
  return (
    error instanceof CarpeDiemError &&
    (error.status === 502 ||
      error.status === 409 ||
      error.code === "MODEL_REQUIRES_ASYNC" ||
      /queue|synchronous|async/i.test(error.message))
  );
}

async function bytesToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

function fromBase64(value: string, type = "image/png"): string {
  return value.startsWith("data:") ? value : `data:${type};base64,${value}`;
}

/** The first image of a JSON answer (`images: [b64 | {b64_json}]`). */
function imageResult(json: Record<string, unknown>): string | null {
  const first = (json.images as unknown[] | undefined)?.[0];
  if (typeof first === "string" && first.trim()) return fromBase64(first);
  if (first && typeof first === "object") {
    const b64 = (first as { b64_json?: unknown }).b64_json;
    if (typeof b64 === "string" && b64.trim()) return fromBase64(b64);
  }
  for (const field of ["b64_json", "image"])
    if (typeof json[field] === "string" && (json[field] as string).length > 100)
      return fromBase64(json[field] as string);
  return null;
}

/** A finished answer: the picture itself, or JSON carrying it. */
async function pictureOf(response: Response): Promise<string | null> {
  const type = response.headers.get("content-type") ?? "";
  if (type.startsWith("image/")) return bytesToDataUrl(await response.blob());
  if (!type.includes("json")) return null;
  return imageResult((await response.json()) as Record<string, unknown>);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    });
  });

/** Polls a queued job until it delivers, fails, or the wait runs out. */
export async function pollJob(call: ImageCall, job: PendingJob): Promise<string> {
  const deadline = Date.now() + (call.waitMs ?? 6 * 60_000);
  const body = { queue_id: job.queueId, id: job.queueId, model: job.model };
  while (Date.now() < deadline) {
    await sleep(call.pollMs ?? 2000, call.signal);
    let response: Response;
    try {
      response = await post(call, `${job.base}/retrieve`, body);
    } catch (error) {
      if (call.signal?.aborted) throw error;
      continue;
    }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        await call.keeper?.done(job.queueId);
        throw await failure(response);
      }
      continue;
    }
    const type = response.headers.get("content-type") ?? "";
    if (type.startsWith("image/")) {
      await call.keeper?.done(job.queueId);
      return bytesToDataUrl(await response.blob());
    }
    if (!type.includes("json")) continue;
    const json = (await response.json()) as Record<string, unknown>;
    const image = imageResult(json);
    if (image) {
      await call.keeper?.done(job.queueId);
      return image;
    }
    const status = String(json.status ?? "").toLowerCase();
    if (status === "failed" || status === "error") {
      await call.keeper?.done(job.queueId);
      throw new CarpeDiemError(
        "generation_failed",
        502,
        typeof json.error === "string" && json.error.trim() ? json.error : "The generation failed.",
      );
    }
    if (status === "completed" || status === "complete" || status === "succeeded") {
      const url = [json.image_url, json.url].find((value) => typeof value === "string");
      // Only the operator's own origin is reachable from this page (CSP).
      if (typeof url === "string" && url.startsWith(call.operator.root)) {
        const download = await call.operator.fetch(url, {
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: call.signal,
        });
        if (download.ok) {
          await call.keeper?.done(job.queueId);
          return bytesToDataUrl(await download.blob());
        }
        continue;
      }
      await call.keeper?.done(job.queueId);
      throw new CarpeDiemError(
        "output_elsewhere",
        502,
        "The picture is ready, but this browser cannot fetch it. Open it in the app.",
      );
    }
  }
  throw new CarpeDiemError(
    "still_pending",
    504,
    "The picture is still being made. Reopen this page later to fetch it.",
  );
}

async function queued(
  call: ImageCall,
  base: PendingJob["base"],
  body: Record<string, unknown>,
): Promise<string> {
  const response = await post(call, `${base}/queue`, body);
  if (!response.ok) throw await failure(response);
  const answer = (await response.json()) as Record<string, unknown>;
  const queueId = String(answer.queue_id ?? answer.id ?? "");
  if (!queueId) throw new CarpeDiemError("invalid_response", 502, "The queue gave no job id.");
  const job: PendingJob = { queueId, base, model: String(body.model), prompt: String(body.prompt) };
  await (call.keeper ?? NO_KEEPER).keep(job);
  return pollJob(call, job);
}

/** `/v1/image/generate`, or its queue for heavy models and when it says so. */
export async function generateImage(
  call: ImageCall,
  request: { model: string; prompt: string; aspectRatio?: string; negativePrompt?: string },
): Promise<Picture> {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    variants: 1,
    format: "png",
    hide_watermark: true,
    safe_mode: false,
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
    ...(request.negativePrompt?.trim() ? { negative_prompt: request.negativePrompt.trim() } : {}),
  };
  const done = (dataUrl: string) => ({ dataUrl, model: request.model, prompt: request.prompt });
  if (heavy(HEAVY_IMAGE_MODELS, request.model))
    return done(await queued(call, "/v1/image/generate", body));
  try {
    const response = await post(call, "/v1/image/generate", body);
    if (!response.ok) throw await failure(response);
    const image = await pictureOf(response);
    if (!image) throw new CarpeDiemError("no_image", 502, "The model returned no picture.");
    return done(image);
  } catch (error) {
    if (isAsyncRetrySignal(error)) return done(await queued(call, "/v1/image/generate", body));
    throw error;
  }
}

/** `/v1/image/edit`: one picture changed as the prompt says. */
export async function editImage(
  call: ImageCall,
  request: { model: string; prompt: string; image: string },
): Promise<Picture> {
  const body = {
    model: request.model,
    prompt: request.prompt,
    image: request.image,
    safe_mode: false,
  };
  const done = (dataUrl: string) => ({ dataUrl, model: request.model, prompt: request.prompt });
  if (heavy(HEAVY_EDIT_MODELS, request.model))
    return done(await queued(call, "/v1/image/edit", body));
  try {
    const response = await post(call, "/v1/image/edit", body);
    if (!response.ok) throw await failure(response);
    const image = await pictureOf(response);
    if (!image) throw new CarpeDiemError("no_image", 502, "The edit did not return a picture.");
    return done(image);
  } catch (error) {
    if (isAsyncRetrySignal(error)) return done(await queued(call, "/v1/image/edit", body));
    throw error;
  }
}

/** `/v1/image/multi-edit`, always queued: up to three pictures in one. */
export async function composeImages(
  call: ImageCall,
  request: { model: string; prompt: string; images: string[] },
): Promise<Picture> {
  const images = request.images.filter((image) => image.trim());
  if (images.length < 2 || images.length > 3)
    throw new CarpeDiemError("invalid_request", 400, "Compose two or three pictures.");
  const body = { model: request.model, prompt: request.prompt, images, safe_mode: false };
  const dataUrl = await queued(call, "/v1/image/multi-edit", body);
  return { dataUrl, model: request.model, prompt: request.prompt };
}

/** Virtual try-on (ADR-0088): the person first, the garment second. */
export function tryOn(
  call: ImageCall,
  request: { model: string; person: string; garment: string; garmentLabel?: string },
): Promise<Picture> {
  return composeImages(call, {
    model: request.model,
    prompt: tryOnPrompt(request.garmentLabel),
    images: [request.person, request.garment],
  });
}
