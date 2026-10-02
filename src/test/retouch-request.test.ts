import { describe, expect, it } from "vitest";
import {
  buildEditRequest,
  defaultRetouchModel,
  EditRequestError,
  editCaps,
  MULTI_EDIT_OPERATOR_CAP,
} from "../lib/studio/retouch/request";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

// The catalog entry the operator published for Ideogram 4.5 edit (2026-10-02).
const IDEOGRAM: MediaModel = {
  id: "ideogram-v4-5-edit",
  name: "Ideogram V4.5 Edit",
  mediaType: "imageEdit",
  tier: "premium",
  privacy: "anonymized",
  offline: false,
  costCredits: 10.76,
  constraints: {
    aspectRatios: ["auto", "1:1", "3:2", "16:9", "9:16", "2:3", "3:4", "4:5"],
    promptCharacterLimit: 10000,
    combineImages: true,
    maxInputImages: 5,
    singleImageAspectRatio: true,
    defaultResolution: "1K",
    resolutions: ["1K", "2K"],
    defaultQuality: "high",
    qualities: ["low", "medium", "high"],
  },
};

const PNG = "data:image/png;base64,AAAA";

describe("edit capabilities", () => {
  it("caps the inputs at what the operator accepts, not what the catalog advertises", () => {
    // Measured: the operator refuses a fourth image even though the catalog says 5.
    expect(editCaps(IDEOGRAM).maxInputs).toBe(MULTI_EDIT_OPERATOR_CAP);
    expect(MULTI_EDIT_OPERATOR_CAP).toBe(3);
  });

  it("keeps a model that cannot combine images to a single input", () => {
    const luma = { ...IDEOGRAM, constraints: { combineImages: false, maxInputImages: 6 } };
    expect(editCaps(luma).maxInputs).toBe(1);
  });

  it("reads resolutions, qualities and explicit ratios", () => {
    const caps = editCaps(IDEOGRAM);
    expect(caps.resolutions).toEqual(["1K", "2K"]);
    expect(caps.defaultResolution).toBe("1K");
    expect(caps.qualities).toEqual(["low", "medium", "high"]);
    expect(caps.defaultQuality).toBe("high");
    expect(caps.aspectRatios).not.toContain("auto");
    expect(caps.promptLimit).toBe(10000);
  });

  it("degrades to the operator cap and no options for an unknown model", () => {
    expect(editCaps(undefined)).toMatchObject({
      maxInputs: MULTI_EDIT_OPERATOR_CAP,
      resolutions: [],
      qualities: [],
      aspectRatios: [],
    });
  });
});

describe("the edit request", () => {
  const caps = editCaps(IDEOGRAM);

  it("always goes through multi-edit, even for one image", () => {
    const request = buildEditRequest(caps, {
      model: IDEOGRAM.id,
      prompt: "  Paint the wall green.  ",
      images: [PNG],
      resolution: "2K",
      quality: "low",
      aspectRatio: "16:9",
    });
    expect(request).toEqual({
      base: "/image/multi-edit",
      body: {
        model: "ideogram-v4-5-edit",
        prompt: "Paint the wall green.",
        images: [PNG],
        safe_mode: false,
        resolution: "2K",
        quality: "low",
        aspect_ratio: "16:9",
      },
    });
  });

  it("drops values the model does not list instead of having them refused after queueing", () => {
    const { body } = buildEditRequest(caps, {
      model: IDEOGRAM.id,
      prompt: "x",
      images: [PNG],
      resolution: "4K",
      quality: "ultra",
      aspectRatio: "4:3",
    });
    expect(body).not.toHaveProperty("resolution");
    expect(body).not.toHaveProperty("quality");
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  it("treats auto as following the source", () => {
    const { body } = buildEditRequest(caps, {
      model: IDEOGRAM.id,
      prompt: "x",
      images: [PNG],
      aspectRatio: "auto",
    });
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  it("refuses what the operator would refuse", () => {
    const attempt = (images: string[], prompt = "x") =>
      buildEditRequest(caps, { model: IDEOGRAM.id, prompt, images });
    expect(() => attempt([])).toThrow(EditRequestError);
    expect(() => attempt([" "])).toThrow(EditRequestError);
    expect(() => attempt([PNG, PNG, PNG, PNG])).toThrow(EditRequestError);
    expect(() => attempt([PNG], "   ")).toThrow(EditRequestError);
    expect(() => attempt([PNG], "x".repeat(10001))).toThrow(EditRequestError);
    expect(attempt([PNG, PNG, PNG]).body.images).toHaveLength(3);
  });
});

describe("the retouch default model", () => {
  const catalog = (models: MediaModel[]): MediaCatalog => ({ backend: "carpe-diem", models });
  const qwen: MediaModel = {
    id: "qwen-image-2-edit",
    name: "Qwen Image 2 Edit",
    mediaType: "imageEdit",
    offline: false,
  };

  it("opens on Ideogram when the catalog has it", () => {
    expect(defaultRetouchModel(catalog([qwen, IDEOGRAM]))?.id).toBe("ideogram-v4-5-edit");
  });

  it("falls back to the automatic edit model otherwise", () => {
    expect(defaultRetouchModel(catalog([qwen]))?.id).toBe("qwen-image-2-edit");
    expect(defaultRetouchModel(catalog([{ ...IDEOGRAM, offline: true }, qwen]))?.id).toBe(
      "qwen-image-2-edit",
    );
  });
});
