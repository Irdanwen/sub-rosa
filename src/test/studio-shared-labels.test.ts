import { describe, expect, it } from "vitest";
import { rateBadge, rateSentence } from "../lib/studio/rate";
import {
  familySubtitle,
  familyTags,
  videoDirectionFilters,
  videoFamilyEntry,
} from "../lib/studio/video-family-entries";
import type { VideoFamily } from "../lib/studio/catalog";
import type { MediaModel } from "../lib/studio/types";

const model = (id: string, over: Partial<MediaModel> = {}): MediaModel =>
  ({ id, name: id, mediaType: "video", offline: false, ...over }) as MediaModel;

describe("today's rate, said as a discount", () => {
  it("reads below, above and at the base price", () => {
    expect(rateBadge(0.43)).toBe("-57 %");
    expect(rateBadge(1.2)).toBe("+20 %");
    expect(rateBadge(1)).toBeUndefined();
    expect(rateBadge(undefined)).toBeUndefined();
    expect(rateSentence(0.43)).toContain("57% below the base price");
    expect(rateSentence(1.2)).toContain("20% above the base price");
    expect(rateSentence(1)).toContain("Today's rate is the base price.");
    expect(rateSentence(Number.NaN)).toBe("Credits pay for renders at the provider's price.");
  });
});

describe("a video family as a picker row", () => {
  const family = {
    key: "kling v3 4k",
    name: "Kling V3 4K",
    textModel: model("kling-v3-4k-text-to-video", { tier: "premium" }),
    referenceModel: model("kling-v3-4k-reference-to-video"),
  } as VideoFamily;

  it("tags its directions and flags the variant that needs an opening frame", () => {
    expect(familyTags(family).map((tag) => tag.label)).toEqual([
      "Text",
      "References",
      "+ opening frame",
    ]);
    expect(familyTags(family).at(-1)?.tone).toBe("note");
  });

  it("is findable by its variants and filtered by direction", () => {
    const entry = videoFamilyEntry(family, ["From a prompt"]);
    expect(entry.groups).toEqual(["text", "reference"]);
    expect(entry.keywords).toContain("From a prompt");
    expect(familySubtitle(family)).toContain("Premium");
    expect(videoDirectionFilters().map((filter) => filter.id)).toEqual([
      "text",
      "image",
      "reference",
    ]);
  });
});
