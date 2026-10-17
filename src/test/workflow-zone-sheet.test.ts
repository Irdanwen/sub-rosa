// A zone retouch and a contact sheet as workflow steps: the retouch sends
// only the rectangle (at a format the model takes) and asks Rust to merge
// the result back into the gallery file it came from; the sheet draws nine
// variations in one square edit.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/studio/retouch/canvas-io", () => ({
  naturalSize: vi.fn(async () => ({ width: 2000, height: 1000 })),
  cropForSending: vi.fn(async () => "data:image/png;base64,Q1JPUA=="),
  prepareSource: vi.fn(async () => "data:image/png;base64,U1JD"),
  rasterizeZone: vi.fn(() => "TUFTSw=="),
}));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: vi.fn(async () => ({
    backend: "carpe-diem",
    models: [
      {
        id: "edit-model",
        mediaType: "imageEdit",
        name: "Edit",
        offline: false,
        constraints: { aspectRatios: ["1:1", "16:9", "4:3"] },
      },
    ],
  })),
}));

import { composePacks, sheetable } from "../lib/studio/compose/packs";
import { cropForSending } from "../lib/studio/retouch/canvas-io";
import { runWorkflow, type WorkflowStorage } from "../lib/studio/workflow/engine";
import { NODE_SCHEMAS, defaultParams, type Workflow } from "../lib/studio/workflow/schema";
import { zoneOf } from "../lib/studio/workflow/zone-param";

const graph = (type: "zoneEdit" | "sheet", params: Record<string, unknown>): Workflow => ({
  id: "w",
  name: "W",
  nodes: [
    {
      id: "pic",
      type: "asset",
      label: "",
      position: { x: 0, y: 0 },
      params: { ...defaultParams("asset"), assetKind: "image", artifactId: "pic-1" },
    },
    {
      id: "step",
      type,
      label: "",
      position: { x: 0, y: 0 },
      params: { ...defaultParams(type), model: "edit-model", ...params },
    },
  ],
  edges: [{ id: "e", source: "pic", target: "step", targetPort: "image" }],
  createdAt: 0,
  updatedAt: 0,
});

function storage() {
  return {
    save: vi.fn(),
    loadAsset: vi.fn(async (artifactId: string) => ({
      kind: "image" as const,
      src: `data:image/png;base64,${artifactId}`,
      base64: artifactId,
      mimeType: "image/png",
      artifactId,
      fileName: `${artifactId}.png`,
    })),
    loadNote: vi.fn(),
    readMedia: vi.fn(),
  } as unknown as WorkflowStorage;
}

const durable = () => vi.fn(async () => ({ artifactId: "made", src: "blob:made" }) as never);

beforeEach(() => vi.mocked(cropForSending).mockClear());

describe("a zone", () => {
  it("stays inside the picture, and a malformed one is the middle half", () => {
    expect(zoneOf({ x: 0.8, y: -1, width: 0.5, height: 2 })).toEqual({
      x: 0.8,
      y: 0,
      width: expect.closeTo(0.2),
      height: 1,
    });
    expect(zoneOf("nonsense")).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  });
});

describe("a zone retouch", () => {
  it("sends the rectangle alone and has it merged back into the gallery file", async () => {
    const durableMedia = durable();
    const run = await runWorkflow(
      graph("zoneEdit", {
        prompt: "make the sky stormy",
        zone: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
      }),
      { storage: storage(), durableMedia },
    );
    expect(run.get("step")?.output).toMatchObject({ kind: "image", artifactId: "made" });
    const request = (durableMedia.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(request).toMatchObject({
      queuePath: "/image/multi-edit/queue",
      composite: { parentFileName: "pic-1.png", maskPngBase64: "TUFTSw==" },
    });
    const [x, y, width, height] = (request.composite as { crop: number[] }).crop;
    // The crop holds the zone (200,100 to 600,400 in pixels) and fits the picture.
    expect(x <= 200 && y <= 100 && x + width >= 600 && y + height >= 400).toBe(true);
    expect(x >= 0 && y >= 0 && x + width <= 2000 && y + height <= 1000).toBe(true);
    expect((request.queueBody as { prompt: string }).prompt).toBe("make the sky stormy");
  });

  it("asks for a picture that is in the gallery", async () => {
    await expect(
      runWorkflow(graph("zoneEdit", { prompt: "x" }), { storage: storage() }),
    ).rejects.toThrow(/in the gallery first/);
  });
});

describe("a contact sheet", () => {
  it("draws the nine variations as one square edit", async () => {
    const durableMedia = durable();
    await runWorkflow(graph("sheet", { pack: "expressions" }), {
      storage: storage(),
      durableMedia,
    });
    const request = (durableMedia.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    const body = request.queueBody as { prompt: string; aspect_ratio?: string };
    expect(body.prompt).toMatch(/three by three grid of nine/);
    expect(body.aspect_ratio).toBe("1:1");
  });

  it("only offers variations that fit in nine panels", () => {
    const offered = NODE_SCHEMAS.sheet.params.find((param) => param.name === "pack")?.enumValues;
    const packs = composePacks();
    expect(offered?.length).toBeGreaterThan(0);
    for (const id of offered ?? []) {
      const pack = packs.find((entry) => entry.id === id);
      expect(pack && sheetable(pack)).toBe(true);
    }
  });
});
