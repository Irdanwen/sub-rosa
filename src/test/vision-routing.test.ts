import { describe, expect, it } from "vitest";
import type { MediaModel } from "../lib/studio/types";
import { mediaModelSupportsVision, resolveTurnModel } from "../lib/vision-routing";

function model(id: string, extra: Partial<MediaModel> = {}): MediaModel {
  return { id, mediaType: "text", name: id, offline: false, ...extra };
}

const MODELS: MediaModel[] = [
  model("text-only"),
  model("vision-flag", { supportsVision: true }),
  model("vision-trait", { traits: ["fast", "vision"] }),
];

describe("mediaModelSupportsVision", () => {
  it("reads the supportsVision flag, a vision trait, and treats unknown as no", () => {
    expect(mediaModelSupportsVision(model("a", { supportsVision: true }))).toBe(true);
    expect(mediaModelSupportsVision(model("a", { traits: ["vision"] }))).toBe(true);
    expect(mediaModelSupportsVision(model("a"))).toBe(false);
    expect(mediaModelSupportsVision(undefined)).toBe(false);
  });
});

describe("resolveTurnModel", () => {
  it("keeps the selected model for a text turn", () => {
    expect(
      resolveTurnModel({ selectedModelId: "text-only", models: MODELS, hasImages: false }),
    ).toBe("text-only");
  });

  it("keeps a vision-capable model on an image turn", () => {
    expect(
      resolveTurnModel({ selectedModelId: "vision-flag", models: MODELS, hasImages: true }),
    ).toBe("vision-flag");
  });

  it("routes a text-only model to a vision model on an image turn", () => {
    expect(
      resolveTurnModel({ selectedModelId: "text-only", models: MODELS, hasImages: true }),
    ).toBe("vision-flag");
  });

  it("routes an unknown or default model to a vision model on an image turn", () => {
    expect(resolveTurnModel({ selectedModelId: "", models: MODELS, hasImages: true })).toBe(
      "vision-flag",
    );
  });

  it("falls back to the selected model when no vision model is available", () => {
    const textOnly = [model("a"), model("b")];
    expect(resolveTurnModel({ selectedModelId: "a", models: textOnly, hasImages: true })).toBe("a");
  });
});
