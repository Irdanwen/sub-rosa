import { describe, expect, it } from "vitest";
import {
  directionLabel,
  familyDirections,
  frameFreeReferenceSibling,
  type VideoFamily,
  variantFor,
  variantHint,
  variantLabel,
} from "../lib/studio/catalog";
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

  it("keeps the search spelling apart from the shown label", () => {
    // `variantLabel` is what people type ("reference to video"); what the form
    // shows goes through `t()` and reads in sentence case, in the user's
    // language (spec/copy-through-t).
    expect(directionLabel("reference")).toBe("Reference to video");
    expect(directionLabel("image")).toBe("Image to video");
    expect(directionLabel("video")).toBe("Video to video");
    expect(directionLabel("text")).toBe("Text to video");
    expect(variantHint(FULL, FULL.referenceModel)).toBe("Reference to video");
  });

  it("lists a family's directions in the order the form asks for their inputs", () => {
    expect(familyDirections(FULL)).toEqual(["text", "image", "reference"]);
    expect(familyDirections({ ...FULL, textModel: undefined })).toEqual(["image", "reference"]);
    expect(
      familyDirections({
        key: "wan",
        name: "Wan",
        videoModel: m("wan-2-7-video-to-video"),
        modelSets: [],
      }),
    ).toEqual(["video"]);
  });

  it("offers the same vendor's frame-free reference family, closest tier first", () => {
    const fam = (key: string, name: string, referenceId: string): VideoFamily => ({
      key,
      name,
      textModel: m(`${referenceId.replace("reference-to-video", "text-to-video")}`),
      referenceModel: m(referenceId),
      modelSets: [],
    });
    const klingV3 = fam("kling v3 4k", "Kling V3 4K", "kling-v3-4k-reference-to-video");
    const families = [
      fam("kling o3 standard", "Kling O3 Standard", "kling-o3-standard-reference-to-video"),
      fam("kling o3 4k", "Kling O3 4K", "kling-o3-4k-reference-to-video"),
      klingV3,
      FULL,
    ];
    expect(frameFreeReferenceSibling(families, klingV3)?.key).toBe("kling o3 4k");
    // Seedance's reference variant runs without a frame: nothing to offer.
    expect(frameFreeReferenceSibling(families, FULL)).toBeUndefined();
    // No frame-free kling at all: nothing from another vendor is offered.
    expect(frameFreeReferenceSibling([klingV3, FULL], klingV3)).toBeUndefined();
  });
});
