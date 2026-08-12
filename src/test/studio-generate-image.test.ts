import { beforeEach, describe, expect, it, vi } from "vitest";

// No network, no Tauri: generateImages only talks through the media client.
// Keep the real MediaError (isAsyncRetrySignal instanceof-checks the class the
// code under test throws); mock only the transport functions.
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(),
  mediaRaw: vi.fn(),
  mediaBinary: vi.fn(),
  mediaGet: vi.fn(),
}));

import { compareBodies, generateImages } from "../lib/studio/generate-image";
import { MediaError, mediaJson, mediaRaw } from "../lib/studio/client";

const mediaJsonMock = vi.mocked(mediaJson);
const mediaRawMock = vi.mocked(mediaRaw);

// A queue submit echoes a queue id keyed by seed; retrieve echoes a distinct
// image keyed by that queue id, so a fan-out of N jobs yields N traceable images.
function wireHappyQueue() {
  mediaJsonMock.mockImplementation(async (path: string, body?: unknown) => {
    if (path === "/image/generate") {
      const n = Number((body as Record<string, unknown>)?.variants ?? 1);
      return { images: Array.from({ length: n }, (_u, i) => `sync-${i}`) };
    }
    const seed = (body as Record<string, unknown>)?.seed ?? "rand";
    return { queue_id: `q-${seed}` };
  });
  mediaRawMock.mockImplementation(async (_path: string, body?: unknown) => {
    const queueId = (body as Record<string, unknown>)?.queue_id;
    return { status: 200, ok: true, bodyBase64: `img-${queueId}` };
  });
}

beforeEach(() => {
  mediaJsonMock.mockReset();
  mediaRawMock.mockReset();
});

describe("generateImages — queue variant fan-out", () => {
  it("fans a heavy model's N variants into N queue jobs (each variants:1)", async () => {
    wireHappyQueue();

    const images = await generateImages("gpt-image-2", {
      model: "gpt-image-2",
      prompt: "a fox",
      variants: 4,
    });

    // Four images back — not the single image the old code returned.
    expect(images).toHaveLength(4);
    const queueSubmits = mediaJsonMock.mock.calls.filter(([p]) => p === "/image/generate/queue");
    expect(queueSubmits).toHaveLength(4);
    // Each fanned-out job asks the backend for a single variant.
    for (const [, body] of queueSubmits) {
      expect((body as Record<string, unknown>).variants).toBe(1);
    }
  });

  it("offsets a fixed seed per variant so the images differ", async () => {
    wireHappyQueue();

    const images = await generateImages("nano-banana-pro", {
      model: "nano-banana-pro",
      prompt: "a city",
      variants: 3,
      seed: 100,
    });

    const seeds = mediaJsonMock.mock.calls
      .filter(([p]) => p === "/image/generate/queue")
      .map(([, body]) => (body as Record<string, unknown>).seed);
    expect(seeds).toEqual([100, 101, 102]);
    // Distinct seeds -> distinct queue ids -> distinct images.
    expect(new Set(images).size).toBe(3);
  });

  it("returns the successful variants when one job fails", async () => {
    mediaJsonMock.mockImplementation(async (_path: string, body?: unknown) => {
      const seed = (body as Record<string, unknown>)?.seed ?? "rand";
      return { queue_id: `q-${seed}` };
    });
    mediaRawMock.mockImplementation(async (_path: string, body?: unknown) => {
      const queueId = (body as Record<string, unknown>)?.queue_id;
      if (queueId === "q-11") throw new MediaError("upstream error", { status: 502 });
      return { status: 200, ok: true, bodyBase64: `img-${queueId}` };
    });

    const images = await generateImages("recraft-v4-pro", {
      model: "recraft-v4-pro",
      prompt: "a boat",
      variants: 3,
      seed: 10,
    });

    // Two of three survive; the paid images are not discarded over one failure.
    expect(images.sort()).toEqual(["img-q-10", "img-q-12"]);
  });

  it("throws when every variant fails", async () => {
    mediaJsonMock.mockResolvedValue({ queue_id: "q" });
    mediaRawMock.mockRejectedValue(new MediaError("upstream error", { status: 502 }));

    await expect(
      generateImages("gpt-image-2", { model: "gpt-image-2", prompt: "x", variants: 2 }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("keeps the single-variant queue path to one job", async () => {
    wireHappyQueue();

    const images = await generateImages("gpt-image-2", {
      model: "gpt-image-2",
      prompt: "one",
      variants: 1,
    });

    expect(images).toHaveLength(1);
    expect(mediaJsonMock.mock.calls.filter(([p]) => p === "/image/generate/queue")).toHaveLength(1);
  });

  it("still routes a standard model through the sync path (no queue)", async () => {
    wireHappyQueue();

    const images = await generateImages("z-image-turbo", {
      model: "z-image-turbo",
      prompt: "sunset",
      variants: 2,
    });

    expect(images).toEqual(["sync-0", "sync-1"]);
    expect(mediaJsonMock).toHaveBeenCalledWith(
      "/image/generate",
      expect.objectContaining({ variants: 2 }),
      undefined,
    );
    expect(mediaRawMock).not.toHaveBeenCalled();
  });

  it("routes qwen-image-3-pro through the queue without trying the sync path", async () => {
    wireHappyQueue();

    const images = await generateImages("qwen-image-3-pro", {
      model: "qwen-image-3-pro",
      prompt: "a fox",
      variants: 1,
    });

    expect(images).toHaveLength(1);
    expect(mediaJsonMock.mock.calls.filter(([p]) => p === "/image/generate")).toHaveLength(0);
    expect(mediaJsonMock.mock.calls.filter(([p]) => p === "/image/generate/queue")).toHaveLength(1);
  });

  it("falls back to the queue when the sync path rejects with 409 MODEL_REQUIRES_ASYNC", async () => {
    // A model not in the heavy list that the backend has since flipped to
    // async-only: the sync call 409s and the request retries on the queue.
    mediaJsonMock.mockImplementation(async (path: string) => {
      if (path === "/image/generate") {
        throw new MediaError(
          "some-new-model exceeds the synchronous request limit - use POST /v1/image/generate/queue (async).",
          { status: 409, code: "MODEL_REQUIRES_ASYNC" },
        );
      }
      return { queue_id: "q-fallback" };
    });
    mediaRawMock.mockResolvedValue({ status: 200, ok: true, bodyBase64: "img-q-fallback" });

    const images = await generateImages("some-new-model", {
      model: "some-new-model",
      prompt: "a fox",
      variants: 1,
    });

    expect(images).toEqual(["img-q-fallback"]);
    expect(mediaJsonMock.mock.calls.filter(([p]) => p === "/image/generate/queue")).toHaveLength(1);
  });
});

describe("compareBodies — side-by-side model comparison", () => {
  const wan = {
    id: "wan-2-7-text-to-image",
    name: "Wan 2.7",
    mediaType: "image" as const,
    offline: false,
    constraints: { aspectRatios: ["1:1", "16:9"] },
  };
  const flux = {
    id: "flux-2-pro",
    name: "Flux 2 Pro",
    mediaType: "image" as const,
    offline: false,
  };

  it("builds one single-variant body per model, keeping only supported settings", () => {
    const runs = compareBodies([wan, flux], "a fox", {
      negativePrompt: "blurry",
      seed: 42,
      aspectRatio: "16:9",
    });
    expect(runs).toHaveLength(2);
    for (const { body } of runs) {
      expect(body.variants).toBe(1);
      expect(body.prompt).toBe("a fox");
      expect(body.negative_prompt).toBe("blurry");
      expect(body.seed).toBe(42);
    }
    // Wan offers 16:9; Flux publishes no aspect list, so it gets none.
    expect(runs[0].body.aspect_ratio).toBe("16:9");
    expect("aspect_ratio" in runs[1].body).toBe(false);
  });

  it("dedupes repeated models and omits blank optional settings", () => {
    const runs = compareBodies([wan, wan, flux], "a fox", { negativePrompt: "  " });
    expect(runs.map((run) => run.model.id)).toEqual(["wan-2-7-text-to-image", "flux-2-pro"]);
    expect("negative_prompt" in runs[0].body).toBe(false);
    expect("seed" in runs[0].body).toBe(false);
  });
});
