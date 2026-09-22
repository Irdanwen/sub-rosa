import { describe, expect, it } from "vitest";
import { readableModelName } from "../lib/model-names";
import type { MediaCatalog } from "../lib/studio/types";

const catalog: MediaCatalog = {
  backend: "carpe-diem",
  models: [{ id: "z-ai-glm-5-3-flash", mediaType: "text", name: "GLM 5.3 Flash", offline: false }],
};

describe("readableModelName", () => {
  it("keeps a real reported name", () => {
    expect(readableModelName("x", "Fast model", catalog)).toBe("Fast model");
  });

  it("asks the catalog when the reported name is the id", () => {
    expect(readableModelName("z-ai-glm-5-3-flash", "z-ai-glm-5-3-flash", catalog)).toBe(
      "GLM 5.3 Flash",
    );
  });

  it("knows the curated image models", () => {
    expect(readableModelName("venice-sd35", undefined, null)).toBe("Venice SD3.5");
  });

  it("makes an unknown id presentable, provider prefix dropped", () => {
    expect(readableModelName("nvidia/parakeet-tdt-0.6b-v3", undefined, null)).toBe(
      "Parakeet Tdt 0.6b V3",
    );
  });
});
