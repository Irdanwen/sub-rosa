import { describe, expect, it } from "vitest";
import { type VideoFamily, variantFor, variantLabel } from "../lib/studio/catalog";
import type { MediaModel } from "../lib/studio/types";

function m(id: string): MediaModel {
  return { id, name: id, mediaType: "video", offline: false };
}

/** A family with every variant, like seedance 2.0. */
const FULL: VideoFamily = {
  key: "seedance-2-0",
  name: "Seedance 2.0",
  textModel: m("seedance-2-0-text-to-video"),
  imageModel: m("seedance-2-0-image-to-video"),
  referenceModel: m("seedance-2-0-reference-to-video"),
  modelSets: [],
};

describe("resolving the variant from the inputs", () => {
  it("takes text to video when nothing visual is provided", () => {
    expect(variantFor(FULL, { hasFrame: false, hasReferences: false })?.id).toBe(
      "seedance-2-0-text-to-video",
    );
  });

  it("takes image to video for a frame alone", () => {
    expect(variantFor(FULL, { hasFrame: true, hasReferences: false })?.id).toBe(
      "seedance-2-0-image-to-video",
    );
  });

  it("takes reference to video as soon as photos are involved", () => {
    expect(variantFor(FULL, { hasFrame: false, hasReferences: true })?.id).toBe(
      "seedance-2-0-reference-to-video",
    );
    // The point of the whole change: a starting frame AND references together,
    // which only the reference contract carries.
    expect(variantFor(FULL, { hasFrame: true, hasReferences: true })?.id).toBe(
      "seedance-2-0-reference-to-video",
    );
  });

  it("falls back within the family rather than resolving to nothing", () => {
    const noReference: VideoFamily = { ...FULL, referenceModel: undefined };
    expect(variantFor(noReference, { hasFrame: true, hasReferences: true })?.id).toBe(
      "seedance-2-0-image-to-video",
    );
    const textOnly: VideoFamily = {
      key: "veo",
      name: "Veo",
      textModel: m("veo3-text-to-video"),
      modelSets: [],
    };
    expect(variantFor(textOnly, { hasFrame: true, hasReferences: true })?.id).toBe(
      "veo3-text-to-video",
    );
    expect(variantFor(undefined, { hasFrame: true, hasReferences: false })).toBeUndefined();
  });

  it("names the variant it resolved to", () => {
    expect(variantLabel("seedance-2-0-reference-to-video")).toBe("reference to video");
    expect(variantLabel("seedance-2-0-image-to-video")).toBe("image to video");
    expect(variantLabel("wan-2-7-video-to-video")).toBe("video to video");
    expect(variantLabel("veo3-fast-text-to-video")).toBe("text to video");
  });
});
