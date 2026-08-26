import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BibleEntry } from "../lib/studio/bible/types";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

const hoisted = vi.hoisted(() => ({
  generateImages: vi.fn(),
  saveArtifact: vi.fn(),
  addRef: vi.fn(),
}));

vi.mock("../lib/studio/generate-image", () => ({ generateImages: hoisted.generateImages }));
vi.mock("../lib/studio/artifacts", () => ({ saveArtifactFromBase64: hoisted.saveArtifact }));
vi.mock("../lib/studio/bible/index", () => ({ addBibleRef: hoisted.addRef }));

import {
  canGenerate,
  generateReference,
  pickPortraitModel,
  portraitCostCredits,
  portraitPrompt,
} from "../lib/studio/bible/portrait";

function model(id: string, over: Partial<MediaModel> = {}): MediaModel {
  return {
    id,
    name: id,
    mediaType: "image",
    offline: false,
    costCredits: 5,
    ...over,
  } as MediaModel;
}

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [
    model("premium", { costCredits: 90 }),
    model("cheap", { costCredits: 2, constraints: { aspect_ratios: ["1:1", "16:9"] } }),
  ],
};

function entry(over: Partial<BibleEntry> = {}): BibleEntry {
  return {
    id: "e1",
    kind: "character",
    name: "Nera",
    traits: "green wool coat, scar over the left brow",
    note: "",
    refs: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

beforeEach(() => {
  hoisted.generateImages.mockReset().mockResolvedValue(["AAAA"]);
  hoisted.saveArtifact.mockReset().mockResolvedValue({ id: "nera.png", fileName: "nera.png" });
  hoisted.addRef.mockReset().mockResolvedValue("ref-1");
});

describe("the prompt a reference is made from", () => {
  it("is the same sentence the shots will carry", () => {
    // The traits are restated on every shot the character is in. Generating
    // the face from anything else makes the reference and the prompts disagree
    // from the first frame.
    const prompt = portraitPrompt(entry(), "portrait");
    expect(prompt).toContain("Nera");
    expect(prompt).toContain("green wool coat, scar over the left brow.");
    expect(prompt).toContain("facing the camera");
  });

  it("distinguishes the roles by framing, so two angles are two angles", () => {
    const front = portraitPrompt(entry(), "portrait");
    const side = portraitPrompt(entry(), "profile");
    expect(front).not.toBe(side);
    expect(side).toContain("profile");
  });

  it("says a place is a place, and keeps people out of it", () => {
    const prompt = portraitPrompt(entry({ kind: "location", name: "The alley" }), "wide");
    expect(prompt).toContain("A place: The alley.");
    expect(prompt).toContain("no people");
  });

  it("survives an entry with nothing described yet", () => {
    const prompt = portraitPrompt(entry({ traits: "" }), "portrait");
    expect(prompt).toContain("Nera");
    expect(prompt).not.toContain("..");
  });
});

describe("which model draws it", () => {
  it("takes the cheapest, because a reference gets redrawn until it is liked", () => {
    expect(pickPortraitModel(catalog)?.id).toBe("cheap");
    expect(portraitCostCredits(catalog)).toBe(2);
  });

  it("has nothing to say on an account that cannot draw", () => {
    const blind: MediaCatalog = { backend: "carpe-diem", models: [] };
    expect(pickPortraitModel(blind)).toBeUndefined();
    expect(portraitCostCredits(blind)).toBeUndefined();
  });
});

describe("generating a reference", () => {
  it("draws it, files it in the gallery, and attaches it to the entry", async () => {
    const made = await generateReference(entry(), "portrait", catalog);
    expect(made.model).toBe("cheap");
    // An ordinary gallery artifact: exportable, reworkable, pickable by hand.
    expect(hoisted.saveArtifact).toHaveBeenCalledWith(
      "AAAA",
      "png",
      expect.objectContaining({ kind: "image", model: "cheap" }),
    );
    expect(hoisted.addRef).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "e1", artifactId: "nera.png", role: "portrait" }),
    );
  });

  it("frames a face square and a place wide", async () => {
    await generateReference(entry(), "portrait", catalog);
    expect(hoisted.generateImages.mock.calls[0][1]).toMatchObject({ aspect_ratio: "1:1" });

    hoisted.generateImages.mockClear();
    await generateReference(entry({ kind: "location" }), "wide", catalog);
    expect(hoisted.generateImages.mock.calls[0][1]).toMatchObject({ aspect_ratio: "16:9" });
  });

  it("omits a ratio the model does not publish rather than being refused for it", async () => {
    const narrow: MediaCatalog = {
      backend: "carpe-diem",
      models: [model("fixed", { constraints: { aspect_ratios: ["16:9"] } })],
    };
    await generateReference(entry(), "portrait", narrow);
    expect(hoisted.generateImages.mock.calls[0][1]).not.toHaveProperty("aspect_ratio");
  });

  it("refuses to draw a voice", async () => {
    expect(canGenerate("voice")).toBe(false);
    await expect(generateReference(entry(), "voice", catalog)).rejects.toThrow(/not a picture/);
    expect(hoisted.generateImages).not.toHaveBeenCalled();
  });

  it("attaches nothing when the model returned nothing", async () => {
    hoisted.generateImages.mockResolvedValue([]);
    await expect(generateReference(entry(), "portrait", catalog)).rejects.toThrow(/no picture/);
    expect(hoisted.addRef).not.toHaveBeenCalled();
  });
});
