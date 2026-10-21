// A character sheet given to a video step (ADR-0066): the step is sent the
// sheet's lead view, never the grid. Handed nine figures, Kling's motion
// control found no one character to move and kept the person in the clip
// ("Recast a clip" with a sheet from the gallery, 2026-10-21). And because
// the request changed, neither key may answer it with a render made from the
// whole grid.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/studio/bible/sheet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/bible/sheet")>()),
  sheetLeadView: vi.fn(async () => "TEVBRA=="),
}));
vi.mock("../lib/studio/retouch/canvas-io", () => ({
  prepareSource: vi.fn(async () => "data:image/png;base64,U1JD"),
}));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: vi.fn(async () => ({
    backend: "carpe-diem",
    models: [
      {
        id: "kling-v3-standard-motion-control",
        mediaType: "video",
        name: "Kling V3 Standard Motion Control",
        offline: false,
        constraints: { durations: ["Auto"], aspect_ratios: [], resolutions: [] },
      },
      {
        id: "edit-model",
        mediaType: "imageEdit",
        name: "Edit",
        offline: false,
        constraints: { aspectRatios: ["1:1"] },
      },
      {
        id: "wan-2-7-image-to-video",
        mediaType: "imageToVideo",
        name: "Wan 2.7",
        offline: false,
      },
    ],
  })),
}));

import { SHEET_LAYOUT } from "../lib/studio/bible/portrait";
import { sheetLeadView } from "../lib/studio/bible/sheet";
import { composePacks, sheetPrompt } from "../lib/studio/compose/packs";
import { runWorkflow, type WorkflowStorage } from "../lib/studio/workflow/engine";
import type { NodeOutput } from "../lib/studio/workflow/run-types";
import { defaultParams, type Workflow, type WorkflowNode } from "../lib/studio/workflow/schema";
import { runtimeKey, staticKeys } from "../lib/studio/workflow/signature";

const MOTION = "kling-v3-standard-motion-control";

function node(id: string, type: WorkflowNode["type"], params: Record<string, unknown> = {}) {
  return {
    id,
    type,
    label: "",
    position: { x: 0, y: 0 },
    params: { ...defaultParams(type), ...params },
  } satisfies WorkflowNode;
}

/** "Recast a clip": a picture of the character, a clip of the movements. */
function recast(characterLabel: string): Workflow {
  return {
    id: "w",
    name: "W",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      node("character", "asset", {
        assetKind: "image",
        artifactId: "character.png",
        assetLabel: characterLabel,
      }),
      node("clip", "asset", { assetKind: "video", artifactId: "walk.mov" }),
      node("recast", "video", { model: MOTION, prompt: "The character walks like the clip." }),
    ],
    edges: [
      { id: "e1", source: "character", target: "recast", targetPort: "openingFrame" },
      { id: "e2", source: "clip", target: "recast", targetPort: "sourceClip" },
    ],
  };
}

function storage(sheet: boolean) {
  return {
    save: vi.fn(),
    loadAsset: vi.fn(async (artifactId: string) =>
      artifactId.endsWith(".mov")
        ? { kind: "video" as const, src: "blob:walk", artifactId }
        : {
            kind: "image" as const,
            src: `data:image/png;base64,${artifactId}`,
            base64: "R1JJRA==",
            mimeType: "image/png",
            artifactId,
            ...(sheet ? { sheet: true } : {}),
          },
    ),
    loadNote: vi.fn(),
    readMedia: vi.fn(async () => "data:video/quicktime;base64,V0FMSw=="),
  } as unknown as WorkflowStorage;
}

const durable = () => vi.fn(async () => ({ artifactId: "made", src: "blob:made" }) as never);

function sentBody(durableMedia: ReturnType<typeof durable>): Record<string, unknown> {
  const request = (durableMedia.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
  return request.queueBody as Record<string, unknown>;
}

beforeEach(() => vi.mocked(sheetLeadView).mockClear());

describe("a sheet given to a video step", () => {
  it("is sent as its lead view, with the clip to move", async () => {
    const durableMedia = durable();
    await runWorkflow(recast(SHEET_LAYOUT), { storage: storage(true), durableMedia });
    expect(sheetLeadView).toHaveBeenCalledWith("data:image/png;base64,R1JJRA==");
    expect(sentBody(durableMedia)).toMatchObject({
      model: MOTION,
      image_url: "data:image/png;base64,TEVBRA==",
      video_url: "data:video/quicktime;base64,V0FMSw==",
    });
  });

  it("leaves a single picture as it is", async () => {
    const durableMedia = durable();
    await runWorkflow(recast("A woman in a black dress"), {
      storage: storage(false),
      durableMedia,
    });
    expect(sheetLeadView).not.toHaveBeenCalled();
    expect(sentBody(durableMedia).image_url).toBe("data:image/png;base64,R1JJRA==");
  });

  it("is cut on its way to an opening frame too, straight from a sheet step", async () => {
    const durableMedia = durable();
    const workflow: Workflow = {
      id: "w",
      name: "W",
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        node("picture", "asset", { assetKind: "image", artifactId: "face.png" }),
        node("sheet", "sheet", { model: "edit-model", pack: "character" }),
        node("shot", "video", { model: "wan-2-7-image-to-video", prompt: "She turns." }),
      ],
      edges: [
        { id: "e1", source: "picture", target: "sheet", targetPort: "image" },
        { id: "e2", source: "sheet", target: "shot", targetPort: "openingFrame" },
      ],
    };
    const run = await runWorkflow(workflow, { storage: storage(false), durableMedia });
    expect(run.get("sheet")?.output).toMatchObject({ kind: "image", sheet: true });
    const shot = (durableMedia.mock.calls[1] as unknown as [string, Record<string, unknown>])[1];
    expect((shot.queueBody as { image_url: string }).image_url).toBe(
      "data:image/png;base64,TEVBRA==",
    );
  });
});

describe("the keys of a video step given a sheet", () => {
  const image = (sheet: boolean): NodeOutput => ({
    kind: "image",
    base64: "R1JJRA==",
    mimeType: "image/png",
    artifactId: "character.png",
    ...(sheet ? { sheet: true } : {}),
  });
  const clip: NodeOutput = { kind: "video", artifactId: "walk.mov", src: "blob:walk" };
  const ports = (sheet: boolean) =>
    new Map<string, NodeOutput[]>([
      ["openingFrame", [image(sheet)]],
      ["sourceClip", [clip]],
    ]);

  it("are new at run time, so a render made from the whole grid is not reused", async () => {
    const step = recast("").nodes[2];
    expect(await runtimeKey(step, ports(true))).not.toBe(await runtimeKey(step, ports(false)));
  });

  it("are new before the run, so that render is not promised free either", async () => {
    const asSheet = await staticKeys(recast(SHEET_LAYOUT));
    const asPicture = await staticKeys(recast("A woman in a black dress"));
    expect(asSheet.get("recast")).not.toBe(asPicture.get("recast"));
    // The pick itself is the same file: only the step that cuts it changes.
    expect(asSheet.get("character")).toBe(asPicture.get("character"));
  });

  it("know a sheet by the prompt every sheet is drawn from", async () => {
    const pack = composePacks().find((entry) => entry.id === "character");
    if (!pack) throw new Error("the character pack is gone");
    const fromPack = await staticKeys(recast(sheetPrompt(pack)));
    const asSheet = await staticKeys(recast(SHEET_LAYOUT));
    expect(fromPack.get("recast")).toBe(asSheet.get("recast"));
  });

  it("stay as they were for any other step", async () => {
    const edit = node("edit", "imageEdit", { model: "edit-model", prompt: "Make it night." });
    const imagePorts = (sheet: boolean) => new Map([["images", [image(sheet)]]]);
    expect(await runtimeKey(edit, imagePorts(true))).toBe(
      await runtimeKey(edit, imagePorts(false)),
    );
  });
});
