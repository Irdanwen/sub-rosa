// The Studio's finishing tools as workflow steps: upscale and cut out a
// picture (paid, priced by use), mix sounds into one track (free, the same
// offline mix as a film's), and compare two pictures (never run).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(),
  mediaRaw: vi.fn(),
}));
const backend = vi.hoisted(() => ({ value: "carpe-diem" as "carpe-diem" | "venice" }));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: vi.fn(async () => ({ backend: backend.value, models: [] })),
}));
vi.mock("../lib/studio/assemble", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/assemble")>()),
  mixSounds: vi.fn(async () => ({
    numberOfChannels: 1,
    length: 2,
    sampleRate: 8000,
    getChannelData: () => new Float32Array([0, 0.5]),
  })),
  blobToBase64: vi.fn(async () => "V0FW"),
}));

import { mixSounds } from "../lib/studio/assemble";
import { mediaRaw } from "../lib/studio/client";
import { estimateNodeCost } from "../lib/studio/workflow/cost";
import { runWorkflow, type WorkflowStorage } from "../lib/studio/workflow/engine";
import { applyModes } from "../lib/studio/workflow/modes";
import {
  defaultParams,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../lib/studio/workflow/schema";
import { audioBufferToWav } from "../lib/studio/wav";

const node = (id: string, type: WorkflowNodeType, params: Record<string, unknown> = {}) =>
  ({
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), ...params },
  }) as WorkflowNode;
const graph = (nodes: WorkflowNode[], edges: Workflow["edges"]): Workflow => ({
  id: "w",
  name: "W",
  nodes,
  edges,
  createdAt: 0,
  updatedAt: 0,
});

function storage() {
  let saves = 0;
  return {
    save: vi.fn(async () => {
      saves += 1;
      return { artifactId: `art-${saves}`, src: `blob:art-${saves}` };
    }),
    loadAsset: vi.fn(async (artifactId: string) =>
      artifactId.startsWith("pic")
        ? { kind: "image" as const, base64: "UElD", mimeType: "image/png", artifactId }
        : { kind: "audio" as const, src: `blob:${artifactId}`, artifactId },
    ),
    loadNote: vi.fn(),
    readMedia: vi.fn(),
  } as unknown as WorkflowStorage & { save: ReturnType<typeof vi.fn> };
}

const picture = () => node("pic", "asset", { assetKind: "image", artifactId: "pic-1" });

beforeEach(() => {
  vi.mocked(mediaRaw).mockReset();
  vi.mocked(mixSounds).mockClear();
  backend.value = "carpe-diem";
});

describe("upscale", () => {
  it("asks for a larger copy at the chosen scale and keeps it in the gallery", async () => {
    vi.mocked(mediaRaw).mockResolvedValueOnce({
      ok: true,
      status: 200,
      bodyBase64: "QklH",
    } as never);
    const kept = storage();
    const run = await runWorkflow(
      graph(
        [picture(), node("up", "upscale", { scale: "4" })],
        [{ id: "e", source: "pic", target: "up", targetPort: "image" }],
      ),
      { storage: kept },
    );
    expect(vi.mocked(mediaRaw)).toHaveBeenCalledWith("/image/upscale", { image: "UElD", scale: 4 });
    expect(run.get("up")?.output).toMatchObject({ kind: "image", base64: "QklH" });
    expect(kept.save).toHaveBeenCalledWith(
      { base64: "QklH" },
      "png",
      expect.objectContaining({ kind: "image", model: "upscale" }),
    );
  });
});

describe("cut out", () => {
  it("says it is not available where the provider has no such route", async () => {
    const run = runWorkflow(
      graph(
        [picture(), node("cut", "cutout")],
        [{ id: "e", source: "pic", target: "cut", targetPort: "image" }],
      ),
      { storage: storage() },
    );
    await expect(run).rejects.toThrow(/not available with this provider/);
    expect(vi.mocked(mediaRaw)).not.toHaveBeenCalled();
  });

  it("removes the background where it can", async () => {
    backend.value = "venice";
    vi.mocked(mediaRaw).mockResolvedValueOnce({
      ok: true,
      status: 200,
      bodyBase64: "Q1VU",
    } as never);
    const run = await runWorkflow(
      graph(
        [picture(), node("cut", "cutout")],
        [{ id: "e", source: "pic", target: "cut", targetPort: "image" }],
      ),
      { storage: storage() },
    );
    expect(vi.mocked(mediaRaw)).toHaveBeenCalledWith("/image/background-remove", { image: "UElD" });
    expect(run.get("cut")?.output).toMatchObject({ kind: "image", base64: "Q1VU" });
  });
});

describe("sound mix", () => {
  it("lays lines end to end, puts the music under them at its level, and keeps one track", async () => {
    const kept = storage();
    const run = await runWorkflow(
      graph(
        [
          node("line1", "asset", { assetKind: "audio", artifactId: "line-1" }),
          node("line2", "asset", { assetKind: "audio", artifactId: "line-2" }),
          node("score", "asset", { assetKind: "audio", artifactId: "score" }),
          node("mix", "soundMix", { audioVolume: 0.3 }),
        ],
        [
          { id: "a", source: "line1", target: "mix", targetPort: "dialogue" },
          { id: "b", source: "line2", target: "mix", targetPort: "dialogue" },
          { id: "c", source: "score", target: "mix", targetPort: "music" },
        ],
      ),
      { storage: kept },
    );
    const asked = vi.mocked(mixSounds).mock.calls[0][0];
    expect(asked.lanes.dialogue?.map((line) => line.src)).toEqual(["blob:line-1", "blob:line-2"]);
    expect((asked.lanes.dialogue?.[1].atSeconds ?? 0) > 0).toBe(true);
    expect(asked.lanes.music).toEqual([{ src: "blob:score", atSeconds: 0, gain: 0.3 }]);
    expect(asked.normalizeToLufs).toBe(-14);
    expect(run.get("mix")?.output).toMatchObject({ kind: "audio", mimeType: "audio/wav" });
    expect(kept.save).toHaveBeenCalledWith(
      { base64: "V0FW" },
      "wav",
      expect.objectContaining({ kind: "music", model: "mix" }),
    );
  });
});

describe("compare", () => {
  it("never runs, and costs nothing", () => {
    const shown = applyModes(
      graph(
        [picture(), node("cmp", "compare")],
        [{ id: "e", source: "pic", target: "cmp", targetPort: "before" }],
      ),
    );
    expect(shown.nodes.map((entry) => entry.id)).toEqual(["pic"]);
    expect(shown.edges).toEqual([]);
  });
});

describe("what these steps cost", () => {
  it("prices upscales and cutouts by use, and mixes and comparisons as free", () => {
    const catalog = { backend: "carpe-diem" as const, models: [] };
    expect(estimateNodeCost(node("u", "upscale"), catalog).kind).toBe("metered");
    expect(estimateNodeCost(node("c", "cutout"), catalog).kind).toBe("metered");
    expect(estimateNodeCost(node("m", "soundMix"), catalog).kind).toBe("free");
    expect(estimateNodeCost(node("v", "compare"), catalog).kind).toBe("free");
  });
});

describe("a WAV file", () => {
  it("has a PCM header and the samples, interleaved and clamped", async () => {
    const left = new Float32Array([0, 1, -2]);
    const right = new Float32Array([0.5, -0.5, 0]);
    const blob = audioBufferToWav({
      numberOfChannels: 2,
      length: 3,
      sampleRate: 44100,
      getChannelData: (channel: number) => (channel === 0 ? left : right),
    } as unknown as AudioBuffer);
    const view = new DataView(await blob.arrayBuffer());
    const text = (at: number) =>
      String.fromCharCode(...[0, 1, 2, 3].map((offset) => view.getUint8(at + offset)));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(40, true)).toBe(12);
    const samples = [0, 1, 2, 3, 4, 5].map((index) => view.getInt16(44 + index * 2, true));
    expect(samples).toEqual([0, 16383, 32767, -16384, -32768, 0]);
  });
});
