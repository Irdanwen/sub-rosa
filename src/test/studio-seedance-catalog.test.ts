/**
 * The seedance reference-to-video variants, against the real catalog.
 *
 * "I cannot see seedance 2.5 R2V on my phone" turned out to be four separate
 * things, and only a fixture captured from the live operator could tell them
 * apart. This suite pins the reachability chain end to end: the catalog entry
 * exists, it lands in the right family slot, the inputs resolve to it, and the
 * family list a shell renders still contains it.
 *
 * Every assertion here is about *reachability*, not presentation. What a surface
 * shows for it is pinned in `studio-seedance-discovery.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { isReferenceToVideoModel, variantFor, videoFamilies } from "../lib/studio/catalog";
import { maxVideoReferences } from "../lib/studio/seedance";
import { seedanceCatalog } from "./fixtures/seedance-catalog";

const catalog = seedanceCatalog();
const families = videoFamilies(catalog);

/** What both shells filter the family list down to before rendering it. */
const listed = families.filter(
  (family) => family.textModel || family.imageModel || family.referenceModel,
);

function family(key: string) {
  const hit = families.find((entry) => entry.key === key);
  if (!hit) throw new Error(`no family ${key}, have: ${families.map((f) => f.key).join(", ")}`);
  return hit;
}

describe("seedance 2.5 reference-to-video is reachable", () => {
  it("lands in the reference slot of the seedance 2.5 family", () => {
    // The three variants share the display name "Seedance 2.5" once the R2V
    // shorthand is stripped, which is what folds them into one family. The
    // reference variant must not be the one that loses the tie.
    const seedance = family("seedance 2.5");
    expect(seedance.textModel?.id).toBe("seedance-2-5-text-to-video-basic");
    expect(seedance.imageModel?.id).toBe("seedance-2-5-image-to-video-basic");
    expect(seedance.referenceModel?.id).toBe("seedance-2-5-reference-to-video-basic");
  });

  it("is what the inputs resolve to once a reference photo is added", () => {
    const seedance = family("seedance 2.5");
    const resolve = (hasFrame: boolean, hasReferences: boolean) =>
      variantFor(seedance, { hasFrame, hasReferences })?.id;

    expect(resolve(false, false)).toBe("seedance-2-5-text-to-video-basic");
    expect(resolve(true, false)).toBe("seedance-2-5-image-to-video-basic");
    expect(resolve(false, true)).toBe("seedance-2-5-reference-to-video-basic");
    // A photo *and* references is still reference-to-video: it is the only
    // variant that carries both an opening frame and reference images.
    expect(resolve(true, true)).toBe("seedance-2-5-reference-to-video-basic");
  });

  it("survives the filter both shells apply to the family list", () => {
    expect(listed.map((entry) => entry.key)).toContain("seedance 2.5");
  });

  it("offers the 30 reference photos the 2.5 contract documents", () => {
    expect(maxVideoReferences(family("seedance 2.5").referenceModel)).toBe(30);
    expect(maxVideoReferences(family("seedance 2.0").referenceModel)).toBe(9);
    // A family with no published figure keeps the conservative default.
    expect(maxVideoReferences(family("kling o3 4k").referenceModel)).toBe(4);
  });
});

describe("what the operator actually publishes", () => {
  it("types every seedance reference variant as image-to-video", () => {
    // Only the direction word in the id (and the display name) tells the two
    // apart; a surface reading `mediaType` alone would see no R2V at all.
    for (const key of ["seedance 2.0", "seedance 2.0 fast", "seedance 2.5"]) {
      const reference = family(key).referenceModel;
      expect(isReferenceToVideoModel(reference?.id ?? "")).toBe(true);
      expect(reference?.mediaType).toBe("imageToVideo");
    }
    // The two non-`-basic` 2.0 entries do carry the dedicated type.
    expect(family("seedance-2-0").referenceModel?.mediaType).toBe("referenceToVideo");
  });

  it("says the -basic reference variants take audio but never clips", () => {
    // Load-bearing: this is what the reference-media gating reads, and it is
    // the opposite of what the family's public guide implies.
    for (const key of ["seedance 2.0", "seedance 2.0 fast", "seedance 2.5"]) {
      const constraints = family(key).referenceModel?.constraints;
      expect(constraints?.video_input).toBe(false);
      expect(constraints?.audio_input).toBe(true);
    }
    // The full 2.0 variants publish neither flag: nobody said, so nothing is
    // ruled out.
    const full = family("seedance-2-0").referenceModel?.constraints;
    expect(full?.video_input).toBeUndefined();
    expect(full?.audio_input).toBeUndefined();
  });

  it("keeps the -basic and full variants of a family apart", () => {
    // They are different models with different resolution menus and different
    // person-media policies, so folding them together would be a lie.
    expect(family("seedance 2.0").referenceModel?.id).toBe("seedance-2-0-reference-to-video-basic");
    expect(family("seedance-2-0").referenceModel?.id).toBe("seedance-2-0-reference-to-video");
  });

  it("ships no full seedance 2.5, so 2.5 references are -basic only", () => {
    const ids = catalog.models.map((entry) => entry.id);
    expect(ids.filter((id) => id.startsWith("seedance-2-5"))).toEqual([
      "seedance-2-5-text-to-video-basic",
      "seedance-2-5-image-to-video-basic",
      "seedance-2-5-reference-to-video-basic",
    ]);
  });
});

describe("the family list a picker renders", () => {
  // Pinned in full because grouping changes are exactly the kind that look
  // harmless and quietly move a model out from under the user. A diff here
  // should be read, not re-baselined.
  it("groups the 22 seedance ids into five -basic families and three full ones", () => {
    // Each full tier sorts straight after the public one it belongs to, and
    // says which it is: on this family that is the difference between taking
    // reference clips and refusing them.
    expect(listed.map((entry) => `${entry.key} | ${entry.name}`)).toEqual([
      "kling o3 4k | Kling O3 4K",
      "seedance 1.5 pro | Seedance 1.5 Pro",
      "seedance-1-5-pro | Seedance 1.5 Pro (full)",
      "seedance 2.0 | Seedance 2.0",
      "seedance-2-0 | Seedance 2.0 (full)",
      "seedance 2.0 fast | Seedance 2.0 Fast",
      "seedance-2-0-fast | Seedance 2.0 Fast (full)",
      "seedance 2.0 mini | Seedance 2.0 Mini",
      "seedance 2.5 | Seedance 2.5",
    ]);
  });

  it("never splits a family over the direction shorthand in its display name", () => {
    // "Seedance 2.5 R2V" and "Seedance 2.5" are the same family; leaving the
    // shorthand in would list the reference variant as a family of its own,
    // with no text or photo direction.
    expect(listed.filter((entry) => /r2v/i.test(entry.name))).toEqual([]);
  });
});
