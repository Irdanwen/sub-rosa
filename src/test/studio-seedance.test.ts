// Seedance's reference contract, as the guide states it: canonical mentions
// route the workflow, and the per-version limits differ inside one family.

import { describe, expect, it } from "vitest";
import {
  canonicalizeMentions,
  detectSeedanceWorkflow,
  isSeedanceReferenceModel,
  looseMentions,
  maxReferenceAudio,
  maxReferenceVideos,
  maxReferenceVideoSeconds,
  maxVideoReferences,
  referenceMention,
  SEEDANCE_WORKFLOWS,
  seedanceImageProblem,
  seedancePersonMediaCaveat,
  seedancePromptAdvice,
  seedanceWorkflowsFor,
  takesReferenceAudio,
  takesReferenceClips,
} from "../lib/studio/seedance";
import type { VideoConstraints } from "../lib/studio/types";

const model = (id: string, constraints?: VideoConstraints) => ({ id, constraints });

describe("reference caps per family", () => {
  it("follows the documented figures per seedance version", () => {
    expect(maxVideoReferences(model("seedance-2-0-reference-to-video-basic"))).toBe(9);
    expect(maxVideoReferences(model("seedance-2-0-fast-reference-to-video-basic"))).toBe(9);
    expect(maxVideoReferences(model("seedance-2-5-reference-to-video"))).toBe(30);
    // 1.5 publishes no figure, and everything else keeps the low default.
    expect(maxVideoReferences(model("seedance-1-5-pro-reference-to-video"))).toBe(4);
    expect(maxVideoReferences(model("kling-2.5-turbo-pro-reference-to-video"))).toBe(4);
    expect(maxVideoReferences(undefined)).toBe(4);
  });

  it("only offers reference clips where the contract has them", () => {
    // The full tier: the id is all there is to go on, and it does take clips.
    expect(takesReferenceClips(model("seedance-2-0-reference-to-video"))).toBe(true);
    // Image-to-video seedance takes frames, not reference media.
    expect(takesReferenceClips(model("seedance-2-0-image-to-video"))).toBe(false);
    expect(takesReferenceClips(model("wan-2-7-reference-to-video"))).toBe(false);

    expect(maxReferenceVideos(model("seedance-2-0-reference-to-video"))).toBe(3);
    expect(maxReferenceVideos(model("seedance-2-5-reference-to-video"))).toBe(10);
    expect(maxReferenceVideos(model("seedance-2-0-image-to-video"))).toBe(0);
    expect(maxReferenceVideoSeconds(model("seedance-2-0-reference-to-video-basic"))).toBe(15);
    expect(maxReferenceVideoSeconds(model("seedance-2-5-reference-to-video"))).toBe(30);
  });
});

describe("what a reference variant will actually accept", () => {
  // The clip workflows are the family's headline feature and the public tier
  // does not have them. Reading the id alone put a clip slot in front of every
  // model whose name said "reference", and the render was billed and wrong.
  const basic = "seedance-2-5-reference-to-video-basic";
  const full = "seedance-2-0-reference-to-video";

  it("believes the published flags over the id, in both directions", () => {
    expect(takesReferenceClips(model(basic, { video_input: false }))).toBe(false);
    expect(takesReferenceAudio(model(basic, { audio_input: true }))).toBe(true);
    // A model nobody would guess takes clips, saying it does.
    expect(takesReferenceClips(model("wan-2-7-video-to-video", { video_input: true }))).toBe(true);
    // And one whose id says reference, saying it takes no audio.
    expect(
      takesReferenceAudio(model("kling-o3-4k-reference-to-video", { audio_input: false })),
    ).toBe(false);
  });

  it("falls back to the id when a flag is absent, minus the -basic tier", () => {
    // "Nobody said" is not "no": the full ids publish only their option lists.
    expect(takesReferenceClips(model(full, { durations: ["5s"] }))).toBe(true);
    expect(takesReferenceAudio(model(full, { durations: ["5s"] }))).toBe(true);
    // The `-basic` tier is measured, so the fallback knows it takes no clips
    // even where the caller has no constraints to hand (workflow port limits).
    expect(takesReferenceClips(model(basic))).toBe(false);
    expect(takesReferenceAudio(model(basic))).toBe(true);
    expect(takesReferenceClips(undefined)).toBe(false);
    expect(takesReferenceAudio(undefined)).toBe(false);
  });

  it("caps each kind of reference media on its own", () => {
    // Sharing one cap meant a model with no clips also accepted no audio.
    expect(maxReferenceVideos(model(basic))).toBe(0);
    expect(maxReferenceAudio(model(basic))).toBe(10);
    expect(maxReferenceAudio(model("seedance-2-0-reference-to-video-basic"))).toBe(3);
    expect(maxReferenceAudio(model("seedance-2-0-image-to-video-basic"))).toBe(0);
  });

  it("withholds the clip workflows from a model that takes no clips", () => {
    // The prompt routes, so an opening the model cannot honour still runs and
    // still bills. Only "Refer to..." survives on the public tier.
    expect(seedanceWorkflowsFor(model(basic)).map((recipe) => recipe.id)).toEqual(["reference"]);
    expect(seedanceWorkflowsFor(model(full)).map((recipe) => recipe.id)).toEqual([
      "reference",
      "edit",
      "extend",
      "stitch",
    ]);
    expect(seedanceWorkflowsFor(model("wan-2-7-reference-to-video"))).toEqual([]);
  });

  it("keeps the prompt contract keyed on the family, not on the media", () => {
    // Mentions and routing read the same on a variant that takes no clips.
    expect(isSeedanceReferenceModel(model(basic))).toBe(true);
    expect(isSeedanceReferenceModel(model("seedance-2-5-image-to-video-basic"))).toBe(false);
    expect(seedancePromptAdvice(model(basic), "a fox in the rain")).toContain("Refer to <Image 1>");
  });
});

describe("referenceMention", () => {
  it("spells seedance mentions canonically and everything else as prose", () => {
    const seedance = model("seedance-2-0-reference-to-video-basic");
    expect(referenceMention(seedance, "image", 1)).toBe("<Image 1>");
    expect(referenceMention(seedance, "video", 2)).toBe("<Video 2>");
    expect(referenceMention(seedance, "audio", 3)).toBe("<Audio 3>");
    expect(referenceMention(model("kling-2.5-turbo-pro-reference-to-video"), "image", 2)).toBe(
      "image 2",
    );
    expect(referenceMention(undefined, "image", 1)).toBe("image 1");
  });

  it("keeps indexes 1-based whatever it is handed", () => {
    const seedance = model("seedance-2-0-reference-to-video-basic");
    expect(referenceMention(seedance, "image", 0)).toBe("<Image 1>");
    expect(referenceMention(seedance, "image", 2.7)).toBe("<Image 2>");
  });
});

describe("detectSeedanceWorkflow", () => {
  it("reads each canonical opening, from the guide's own examples", () => {
    for (const recipe of SEEDANCE_WORKFLOWS) {
      expect(detectSeedanceWorkflow(recipe.example)).toBe(recipe.id);
    }
  });

  it("says nothing when the prompt matches no canonical opening", () => {
    // The misrouting case: a reference request written as plain prose.
    expect(detectSeedanceWorkflow("Make the video rainy instead of sunny")).toBeUndefined();
    expect(detectSeedanceWorkflow("edit <Video 1> to be rainy")).toBeUndefined();
    expect(detectSeedanceWorkflow("")).toBeUndefined();
  });
});

describe("seedancePromptAdvice", () => {
  const seedance = model("seedance-2-0-reference-to-video-basic");

  it("stays quiet on a correctly written reference prompt", () => {
    expect(
      seedancePromptAdvice(seedance, "Refer to <Subject 1> in <Image 1> to generate a shot"),
    ).toBeUndefined();
    expect(seedancePromptAdvice(seedance, "Extend <Video 1>, generate a chase")).toBeUndefined();
  });

  it("names the loose mentions that would be read as prose", () => {
    const advice = seedancePromptAdvice(seedance, "Refer to image 1 to generate a shot");
    expect(advice).toContain("image 1");
    expect(advice).toContain("<Image 1>");
  });

  it("points at the canonical openings when the prompt would misroute", () => {
    const advice = seedancePromptAdvice(seedance, "make the sky stormy");
    expect(advice).toContain("Strictly edit");
    expect(advice).toContain("Extend");
  });

  it("says nothing for models with no such contract, or an empty prompt", () => {
    expect(seedancePromptAdvice(model("kling-x-reference-to-video"), "anything")).toBeUndefined();
    // Seedance image-to-video takes frames, not prompt-routed references.
    expect(
      seedancePromptAdvice(model("seedance-2-0-image-to-video-basic"), "the keeper turns"),
    ).toBeUndefined();
    expect(seedancePromptAdvice(seedance, "   ")).toBeUndefined();
  });
});

describe("seedanceImageProblem", () => {
  const seedance = model("seedance-2-0-reference-to-video-basic");

  it("accepts a photo inside the documented shape and size", () => {
    expect(seedanceImageProblem(seedance, { width: 1024, height: 1024 })).toBeUndefined();
    expect(seedanceImageProblem(seedance, { width: 1920, height: 1080 })).toBeUndefined();
    expect(seedanceImageProblem(seedance, { width: 300, height: 400 })).toBeUndefined();
  });

  it("refuses a photo below the minimum side", () => {
    const problem = seedanceImageProblem(seedance, { width: 280, height: 900 });
    expect(problem).toContain("300px");
  });

  it("refuses shapes outside the allowed ratio, both ways", () => {
    expect(seedanceImageProblem(seedance, { width: 3000, height: 1000 })).toContain("wide");
    expect(seedanceImageProblem(seedance, { width: 1000, height: 3000 })).toContain("tall");
    // The bounds are exclusive in the contract.
    expect(seedanceImageProblem(seedance, { width: 1000, height: 400 })).toBeDefined();
  });

  it("has nothing to say about other families, or an unmeasurable image", () => {
    expect(seedanceImageProblem(model("kling-x"), { width: 10, height: 4000 })).toBeUndefined();
    expect(seedanceImageProblem(seedance, { width: 0, height: 0 })).toBeUndefined();
  });
});

describe("seedancePersonMediaCaveat", () => {
  it("warns on the public -basic variants, which refuse people whatever is attested", () => {
    expect(seedancePersonMediaCaveat(model("seedance-2-0-reference-to-video-basic"))).toContain(
      "recognisable person",
    );
  });

  it("stays quiet where the attestation does work", () => {
    expect(seedancePersonMediaCaveat(model("seedance-1-5-pro-reference-to-video"))).toBeUndefined();
    expect(seedancePersonMediaCaveat(model("kling-x"))).toBeUndefined();
  });
});

describe("mention spelling", () => {
  it("finds the loose spellings that would be read as prose", () => {
    expect(looseMentions("Refer to image 1 and video 2")).toEqual(["image 1", "video 2"]);
    // Already canonical: nothing to report.
    expect(looseMentions("Refer to <Image 1> to generate a shot")).toEqual([]);
    expect(looseMentions("A shot of an imagemaker 3000")).toEqual([]);
  });

  it("rewrites loose spellings into canonical ones, leaving the rest alone", () => {
    expect(canonicalizeMentions("Refer to image 1 and audio 2, keep <Video 1>")).toBe(
      "Refer to <Image 1> and <Audio 2>, keep <Video 1>",
    );
    expect(canonicalizeMentions("no mentions here")).toBe("no mentions here");
  });
});
