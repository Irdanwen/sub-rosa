import { describe, expect, it } from "vitest";
import { SHEET_LAYOUT, portraitPrompt } from "../lib/studio/bible/portrait";
import { referenceStack } from "../lib/studio/bible/prompt";
import { gridBounds, SHEET_CUTS, sheetCell } from "../lib/studio/bible/sheet";
import {
  BIBLE_ROLE_LABELS,
  ROLES_BY_KIND,
  type BibleRef,
  type BibleRole,
} from "../lib/studio/bible/types";
import { compileBibleReference, compileOpeningImage } from "../lib/studio/project-production";
import {
  newShot,
  referencePromptOf,
  sheetSource,
  type ProjectBibleEntry,
} from "../lib/studio/projects";
import type { MediaCatalog } from "../lib/studio/types";

/**
 * The character sheet: nine views of one character, which composes frames,
 * gives a portrait and a profile to cut out, and never rides to a video model
 * (ADR-0066).
 */

function ref(artifactId: string, role: BibleRole, ordinal: number): BibleRef {
  return { id: `r-${artifactId}`, entryId: "marie", artifactId, role, label: "", ordinal };
}

function marie(over: Partial<ProjectBibleEntry> = {}): ProjectBibleEntry {
  return {
    id: "marie",
    kind: "character",
    name: "Marie",
    traits: "Short red hair, green coat",
    note: "",
    refs: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    { id: "flux-2-pro", name: "Flux 2 Pro", mediaType: "image", offline: false, costCredits: 0.04 },
    { id: "nano-banana-2-edit", name: "Nano Banana 2", mediaType: "imageEdit", offline: false },
  ],
};

describe("the sheet role", () => {
  it("is offered for characters only, with a label", () => {
    expect(ROLES_BY_KIND.character).toContain("sheet");
    expect(ROLES_BY_KIND.location).not.toContain("sheet");
    expect(BIBLE_ROLE_LABELS.sheet).toBeTruthy();
  });

  it("describes the grid the cutter reads", () => {
    const prompt = portraitPrompt(marie(), "sheet");
    expect(prompt).toContain(SHEET_LAYOUT);
    expect(prompt).toContain("Middle row: head and shoulders from the front");
    expect(prompt).toContain("head and shoulders in profile. Bottom row");
  });

  it("never rides to a video model", () => {
    const withSheet = marie({
      refs: [ref("sheet.png", "sheet", 0), ref("face.png", "portrait", 1)],
    });
    expect(referenceStack({ characters: [withSheet] }).map((item) => item.artifactId)).toEqual([
      "face.png",
    ]);
    const onlySheet = marie({ refs: [ref("sheet.png", "sheet", 0)] });
    expect(referenceStack({ characters: [onlySheet] })).toEqual([]);
  });
});

describe("cutting a sheet", () => {
  it("keeps the middle row's front and profile views, and the full body outfit", () => {
    expect(SHEET_CUTS).toEqual([
      { cell: 0, role: "outfit" },
      { cell: 3, role: "portrait" },
      { cell: 5, role: "profile" },
    ]);
  });

  it("finds each cell of an equal grid and shaves the gutter", () => {
    // 1200 square, no margin: cells are 400 wide, the inset shaves 20 px a side.
    const whole = { x: 0, y: 0, width: 1200, height: 1200 };
    expect(sheetCell(whole, 0)).toEqual({ x: 20, y: 20, width: 360, height: 360 });
    expect(sheetCell(whole, 3)).toEqual({ x: 20, y: 420, width: 360, height: 360 });
    expect(sheetCell(whole, 5)).toEqual({ x: 820, y: 420, width: 360, height: 360 });
    expect(sheetCell(whole, 8)).toEqual({ x: 820, y: 820, width: 360, height: 360 });
  });

  it("cuts inside the grid, not the image, when a margin surrounds it", () => {
    const cell = sheetCell({ x: 30, y: 30, width: 1140, height: 1140 }, 3);
    expect(cell).toEqual({ x: 49, y: 429, width: 342, height: 342 });
  });

  it("trims the plain margin a model draws around the grid", () => {
    // 100 by 100 grey, with a coloured grid from 10 to 89 on both axes.
    const size = 100;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const inside = x >= 10 && x < 90 && y >= 10 && y < 90;
        pixels.set(inside ? [200, 60, 40, 255] : [160, 160, 160, 255], i);
      }
    expect(gridBounds(pixels, size, size)).toEqual({ x: 10, y: 10, width: 80, height: 80 });
  });

  it("keeps the whole image when there is no margin to trim", () => {
    const size = 60;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++)
      pixels.set(i % 7 ? [240, 240, 240, 255] : [20, 20, 20, 255], i * 4);
    expect(gridBounds(pixels, size, size)).toEqual({ x: 0, y: 0, width: 60, height: 60 });
  });
});

describe("drawing a sheet", () => {
  it("starts from the portrait through an edit model, so the face stays the one chosen", () => {
    const entry = marie({ refs: [ref("face.png", "portrait", 0)] });
    expect(sheetSource(entry)).toBe("face.png");
    const workflow = compileBibleReference(entry, "sheet", catalog, "Project");
    const target = workflow.nodes.find((node) => node.id === "bible-marie-sheet");
    expect(target?.type).toBe("imageEdit");
    expect(target?.params.model).toBe("nano-banana-2-edit");
    expect(String(target?.params.prompt)).toMatch(/^Keep the identity of the person in image 1/);
    expect(String(target?.params.prompt)).toContain(SHEET_LAYOUT);
    expect(workflow.edges).toEqual([
      expect.objectContaining({ target: "bible-marie-sheet", targetPort: "images" }),
    ]);
    expect(workflow.nodes.find((node) => node.type === "asset")?.params.artifactId).toBe(
      "face.png",
    );
  });

  it("is drawn from text, square, when there is no portrait yet", () => {
    const workflow = compileBibleReference(marie(), "sheet", catalog, "Project");
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.nodes[0]).toMatchObject({
      type: "image",
      params: { model: "flux-2-pro", aspectRatio: "1:1", bibleRole: "sheet" },
    });
  });
});

describe("a prompt per role", () => {
  it("keeps the old single prompt for the single views, never for the sheet", () => {
    const legacy = marie({ imagePrompt: "A tight headshot of Marie." });
    expect(referencePromptOf(legacy, "portrait")).toBe("A tight headshot of Marie.");
    expect(referencePromptOf(legacy, "sheet")).toBeUndefined();
  });

  it("uses the role's own prompt once the person wrote one", () => {
    const entry = marie({
      imagePrompt: "Old.",
      imagePrompts: { profile: "Marie in profile." },
    });
    expect(referencePromptOf(entry, "profile")).toBe("Marie in profile.");
    expect(referencePromptOf(entry, "portrait")).toBe("Old.");
    const workflow = compileBibleReference(entry, "profile", catalog, "Project");
    expect(workflow.nodes[0]?.params.prompt).toBe("Marie in profile.");
  });
});

describe("the opening image of a shot", () => {
  it("is composed in the project's format, with the automatic edit model by default", () => {
    const shot = {
      ...newShot(0),
      id: "s1",
      imagePrompt: "Marie from image 1 in the flat of image 2.",
      imageReferenceIds: ["sheet.png", "flat.png"],
    };
    const workflow = compileOpeningImage(shot, "Project", catalog, "16:9");
    const target = workflow.nodes.find((node) => node.id === "image-s1");
    expect(target).toMatchObject({
      type: "imageEdit",
      params: { model: "nano-banana-2-edit", aspectRatio: "16:9" },
    });
    expect(workflow.edges.map((edge) => edge.source)).toEqual(["reference-0", "reference-1"]);
  });
});
