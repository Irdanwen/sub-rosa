import { beforeEach, describe, expect, it, vi } from "vitest";

// No network, no Tauri: generateImages only talks through the media client.
vi.mock("../lib/studio/client", () => {
  class MediaError extends Error {
    status: number;
    code?: string;

    constructor(message: string, options: { status: number; code?: string }) {
      super(message);
      this.name = "MediaError";
      this.status = options.status;
      this.code = options.code;
    }
  }
  return {
    MediaError,
    mediaJson: vi.fn(),
    mediaRaw: vi.fn(),
    mediaBinary: vi.fn(),
    mediaGet: vi.fn(),
  };
});

import { generateImages } from "../lib/studio/generate-image";
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
    );
    expect(mediaRawMock).not.toHaveBeenCalled();
  });
});
