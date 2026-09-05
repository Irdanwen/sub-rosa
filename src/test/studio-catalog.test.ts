import { describe, expect, it } from "vitest";
import { normalizeJobStatus } from "../lib/studio/async-job";
import {
  defaultEditModel,
  estimateCostCredits,
  imageEditModels,
  isSeedanceModel,
  isSoundEffectsModel,
  musicCapabilities,
  musicModels,
  soundEffectsModels,
  supportsBackgroundRemoval,
  videoFamilies,
  videoFamilyKey,
  withVideoConstraintFallbacks,
} from "../lib/studio/catalog";
import { musicPaths, retrieveBody, supportsVideoQuote } from "../lib/studio/paths";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

function model(overrides: Partial<MediaModel> & Pick<MediaModel, "id" | "mediaType">): MediaModel {
  return { name: overrides.id, offline: false, ...overrides };
}

function catalog(models: MediaModel[]): MediaCatalog {
  return { backend: "carpe-diem", priceMultiplier: 0.5, models };
}

describe("video family grouping", () => {
  it("groups the t2v and i2v variants of one family behind one entry", () => {
    const grouped = videoFamilies(
      catalog([
        model({
          id: "kling-2.5-turbo-pro-text-to-video",
          mediaType: "video",
          name: "Kling 2.5 Turbo Pro Text To Video",
          modelSets: ["cinematic"],
        }),
        model({
          id: "kling-2.5-turbo-pro-image-to-video",
          mediaType: "imageToVideo",
          name: "Kling 2.5 Turbo Pro Image To Video",
          modelSets: ["photorealistic"],
        }),
        model({ id: "sora-2-text-to-video", mediaType: "video", name: "Sora 2 Text To Video" }),
      ]),
    );

    expect(grouped).toHaveLength(2);
    const kling = grouped.find((family) => family.key.includes("kling"));
    expect(kling?.textModel?.id).toBe("kling-2.5-turbo-pro-text-to-video");
    expect(kling?.imageModel?.id).toBe("kling-2.5-turbo-pro-image-to-video");
    expect(kling?.name).toBe("Kling 2.5 Turbo Pro");
    expect(kling?.modelSets).toEqual(["cinematic", "photorealistic"]);
    const sora = grouped.find((family) => family.key.includes("sora"));
    expect(sora?.textModel).toBeDefined();
    expect(sora?.imageModel).toBeUndefined();
  });

  it("falls back to the id minus its direction suffix when there is no display name", () => {
    expect(videoFamilyKey(model({ id: "wan-2-7-image-to-video", mediaType: "imageToVideo" }))).toBe(
      "wan-2-7",
    );
  });

  it("cuts the direction out of the middle and keeps the tier suffix", () => {
    // The public tier appends `-basic` after the direction, so trimming the end
    // left every unnamed public model in a family of its own. Keeping `-basic`
    // in the key is what stops the two tiers merging: they have different
    // limits and different person-media policies.
    expect(
      videoFamilyKey(model({ id: "seedance-2-0-image-to-video-basic", mediaType: "imageToVideo" })),
    ).toBe("seedance-2-0-basic");
    expect(
      videoFamilyKey(model({ id: "seedance-2-0-image-to-video", mediaType: "imageToVideo" })),
    ).toBe("seedance-2-0");
  });

  it("names an unnamed family readably, and its tier only when both are offered", () => {
    const grouped = videoFamilies(
      catalog([
        // Two tiers of one family, neither named by Venice.
        model({ id: "seedance-2-0-fast-text-to-video", mediaType: "video" }),
        model({ id: "seedance-2-0-fast-text-to-video-basic", mediaType: "video" }),
        // A one-off with no sibling: a tier label would mean nothing on it.
        model({ id: "topaz-video-upscale", mediaType: "video" }),
      ]),
    );
    const names = grouped.map((entry) => entry.name);
    expect(names).toContain("Seedance 2.0 Fast (full)");
    expect(names).toContain("Seedance 2.0 Fast (basic)");
    expect(names).toContain("Topaz Video Upscale");
  });

  it("routes video-to-video and upscalers to their own slot instead of shadowing text", () => {
    const grouped = videoFamilies(
      catalog([
        model({ id: "wan-2-7-text-to-video", mediaType: "video" }),
        model({ id: "wan-2-7-video-to-video", mediaType: "video" }),
        model({ id: "topaz-video-upscale", mediaType: "video" }),
      ]),
    );
    const wan = grouped.find((family) => family.key === "wan-2-7");
    expect(wan?.textModel?.id).toBe("wan-2-7-text-to-video");
    expect(wan?.videoModel?.id).toBe("wan-2-7-video-to-video");
    const topaz = grouped.find((family) => family.key.includes("topaz"));
    expect(topaz?.videoModel?.id).toBe("topaz-video-upscale");
    expect(topaz?.textModel).toBeUndefined();
  });

  it("keeps reference-to-video in its own slot instead of clobbering image-to-video", () => {
    // Both are typed `imageToVideo`; a single slot used to drop whichever
    // registered second. The reference variant must stay reachable.
    const grouped = videoFamilies(
      catalog([
        model({ id: "wan-2-7-image-to-video", mediaType: "imageToVideo" }),
        model({ id: "wan-2-7-reference-to-video", mediaType: "imageToVideo" }),
      ]),
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0].imageModel?.id).toBe("wan-2-7-image-to-video");
    expect(grouped[0].referenceModel?.id).toBe("wan-2-7-reference-to-video");
  });

  it("picks up the dedicated reference-to-video type and keeps it in its family", () => {
    // Carpe Diem moved most reference-to-video models out of `imageToVideo`
    // into their own type; reading only the two old types hid them entirely.
    // Their display name carries a direction shorthand that must not split the
    // family in two.
    const grouped = videoFamilies(
      catalog([
        model({ id: "kling-o3-4k-text-to-video", mediaType: "video", name: "Kling O3 4K" }),
        model({
          id: "kling-o3-4k-reference-to-video",
          mediaType: "referenceToVideo",
          name: "Kling O3 4K R2V",
        }),
        model({
          id: "happyhorse-1-0-reference-to-video",
          mediaType: "referenceToVideo",
          name: "HappyHorse 1.0 Reference",
        }),
        // No Venice spec publishes the seedance names, so these group by id.
        model({ id: "seedance-2-0-text-to-video", mediaType: "video" }),
        model({ id: "seedance-2-0-reference-to-video", mediaType: "referenceToVideo" }),
      ]),
    );

    const kling = grouped.find((family) => family.key === "kling o3 4k");
    expect(kling?.textModel?.id).toBe("kling-o3-4k-text-to-video");
    expect(kling?.referenceModel?.id).toBe("kling-o3-4k-reference-to-video");
    expect(kling?.name).toBe("Kling O3 4K");
    const seedance = grouped.find((family) => family.key === "seedance-2-0");
    expect(seedance?.referenceModel?.id).toBe("seedance-2-0-reference-to-video");
    // A family with only a reference variant still shows up under it.
    const happyhorse = grouped.find((family) => family.key === "happyhorse 1.0");
    expect(happyhorse?.referenceModel?.id).toBe("happyhorse-1-0-reference-to-video");
    expect(happyhorse?.textModel).toBeUndefined();
  });
});

describe("video duration fallbacks", () => {
  it("fills durations for seedance models the catalogs never constrain", () => {
    const patched = withVideoConstraintFallbacks(
      catalog([
        model({ id: "seedance-2-0-image-to-video", mediaType: "imageToVideo" }),
        model({ id: "seedance-2-0-reference-to-video", mediaType: "referenceToVideo" }),
        model({ id: "seedance-1-5-pro-text-to-video", mediaType: "video" }),
        model({ id: "veo3-fast-text-to-video", mediaType: "video" }),
      ]),
    );
    const byId = new Map(patched.models.map((entry) => [entry.id, entry]));
    const seedance2 = byId.get("seedance-2-0-image-to-video")?.constraints?.durations;
    expect(seedance2?.[0]).toBe("4s");
    expect(seedance2?.at(-1)).toBe("15s");
    // The dedicated reference type needs the same menu: seedance rejects a
    // request with no `duration`.
    expect(byId.get("seedance-2-0-reference-to-video")?.constraints?.durations?.at(-1)).toBe("15s");
    const seedance15 = byId.get("seedance-1-5-pro-text-to-video")?.constraints?.durations;
    expect(seedance15?.at(-1)).toBe("12s");
    // A family nobody probed stays untouched: an invented menu would be a
    // guess, and an unrecognised value is rejected as hard as a missing one.
    expect(byId.get("veo3-fast-text-to-video")?.constraints).toBeUndefined();
  });

  it("never overrides durations the live catalog already publishes", () => {
    const patched = withVideoConstraintFallbacks(
      catalog([
        model({
          id: "seedance-2-0-image-to-video",
          mediaType: "imageToVideo",
          constraints: { durations: ["5s", "10s"] },
        }),
      ]),
    );
    expect(patched.models[0].constraints?.durations).toEqual(["5s", "10s"]);
  });
});

describe("seedance detection", () => {
  it("flags every seedance variant by id and leaves other families alone", () => {
    expect(isSeedanceModel("seedance-2-0-image-to-video")).toBe(true);
    expect(isSeedanceModel("seedance-1-5-pro-reference-to-video")).toBe(true);
    expect(isSeedanceModel("Seedance-2-0-text-to-video")).toBe(true);
    expect(isSeedanceModel("wan-2-7-image-to-video")).toBe(false);
    expect(isSeedanceModel("kling-2.5-turbo-pro-image-to-video")).toBe(false);
  });
});

describe("image edit models", () => {
  it("adds the unlisted qwen-edit-uncensored passthrough on Carpe Diem, once", () => {
    const models = imageEditModels(
      catalog([
        model({ id: "seedream-v4-edit", mediaType: "imageEdit", name: "Seedream v4 Edit" }),
      ]),
    );
    expect(models.map((entry) => entry.id)).toContain("qwen-edit-uncensored");
  });

  it("does not duplicate it when the operator already lists it", () => {
    const models = imageEditModels(
      catalog([model({ id: "qwen-edit-uncensored", mediaType: "imageEdit" })]),
    );
    expect(models.filter((entry) => entry.id === "qwen-edit-uncensored")).toHaveLength(1);
  });

  it("leaves the Venice-direct catalog untouched", () => {
    const venice: MediaCatalog = {
      backend: "venice",
      priceMultiplier: 1,
      models: [model({ id: "seedream-v4-edit", mediaType: "imageEdit" })],
    };
    expect(imageEditModels(venice).map((entry) => entry.id)).toEqual(["seedream-v4-edit"]);
  });

  it("never resurrects a passthrough that the live catalog marks offline", () => {
    const models = imageEditModels(
      catalog([model({ id: "qwen-edit-uncensored", mediaType: "imageEdit", offline: true })]),
    );
    expect(models).toEqual([]);
  });
});

describe("cost estimates", () => {
  it("uses duration brackets for music, scaled by the price multiplier", () => {
    const ace = model({
      id: "ace-step-15",
      mediaType: "music",
      pricing: {
        durations: {
          "60": { usd: 0.04, min_seconds: 60, max_seconds: 60 },
          "90": { usd: 0.08, min_seconds: 61, max_seconds: 90 },
        },
      },
    });
    expect(estimateCostCredits(ace, { durationSeconds: 60, multiplier: 0.5 })).toBe(2);
    expect(estimateCostCredits(ace, { durationSeconds: 75, multiplier: 0.5 })).toBe(4);
  });

  it("falls back to the flat credit price", () => {
    const image = model({ id: "seedream-v4", mediaType: "image", costCredits: 2.5 });
    expect(estimateCostCredits(image)).toBe(2.5);
    expect(estimateCostCredits(model({ id: "x", mediaType: "image" }))).toBeUndefined();
  });
});

describe("music input rules", () => {
  it("matches the per-model lyrics matrix", () => {
    expect(musicCapabilities("minimax-music-v2").lyrics).toBe("required");
    expect(musicCapabilities("ace-step-15").lyrics).toBe("optional");
    expect(musicCapabilities("elevenlabs-music").lyrics).toBe("none");
    expect(musicCapabilities("stable-audio-25").lyrics).toBe("none");
    expect(musicCapabilities("elevenlabs-sound-effects-v2").lyrics).toBe("none");
    // Unknown models stay permissive so new backend models remain usable.
    expect(musicCapabilities("brand-new-model").lyrics).toBe("optional");
  });
});

describe("automatic edit model", () => {
  it("prefers the capable default, then falls back to the first edit model", () => {
    const preferred = catalog([
      model({ id: "seedream-v4-edit", mediaType: "imageEdit" }),
      model({ id: "qwen-image-2-edit", mediaType: "imageEdit" }),
    ]);
    expect(defaultEditModel(preferred)?.id).toBe("qwen-image-2-edit");

    const fallback = catalog([model({ id: "firered-image-edit", mediaType: "imageEdit" })]);
    expect(defaultEditModel(fallback)?.id).toBe("firered-image-edit");
  });
});

describe("background removal support", () => {
  it("only lights up on the Venice backend (Carpe Diem has no callable route)", () => {
    expect(supportsBackgroundRemoval(catalog([]))).toBe(false);
    expect(supportsBackgroundRemoval({ backend: "venice", priceMultiplier: 1, models: [] })).toBe(
      true,
    );
  });
});

describe("music vs sound effects partition", () => {
  const audio = catalog([
    model({ id: "elevenlabs-music", mediaType: "music" }),
    model({ id: "elevenlabs-sound-effects-v2", mediaType: "music" }),
    model({ id: "mmaudio-v2-text-to-audio", mediaType: "music" }),
    model({ id: "ace-step-15", mediaType: "music" }),
  ]);

  it("flags sound-effect generators by id", () => {
    expect(isSoundEffectsModel("elevenlabs-sound-effects-v2")).toBe(true);
    expect(isSoundEffectsModel("mmaudio-v2-text-to-audio")).toBe(true);
    expect(isSoundEffectsModel("elevenlabs-music")).toBe(false);
  });

  it("splits the music catalog type into two disjoint surfaces", () => {
    const music = musicModels(audio).map((entry) => entry.id);
    const sfx = soundEffectsModels(audio).map((entry) => entry.id);
    expect(music).toEqual(["ace-step-15", "elevenlabs-music"]);
    expect(sfx).toEqual(["elevenlabs-sound-effects-v2", "mmaudio-v2-text-to-audio"]);
  });
});

describe("backend paths", () => {
  it("routes music endpoints by backend", () => {
    expect(musicPaths("carpe-diem")).toEqual({
      queue: "/audio/music/queue",
      retrieve: "/audio/music/retrieve",
    });
    expect(musicPaths("venice")).toEqual({
      queue: "/audio/queue",
      retrieve: "/audio/retrieve",
    });
  });

  it("builds the superset retrieve body and skips quotes for ltx models", () => {
    expect(retrieveBody("q-1", "wan-2-7")).toEqual({
      id: "q-1",
      queue_id: "q-1",
      model: "wan-2-7",
    });
    expect(supportsVideoQuote("ltx-2-pro")).toBe(false);
    expect(supportsVideoQuote("kling-2.6-pro-text-to-video")).toBe(true);
    // Probed 2026-07-20: quote rejects these families outright.
    expect(supportsVideoQuote("wan-2-7-video-to-video")).toBe(false);
    expect(supportsVideoQuote("topaz-video-upscale")).toBe(false);
  });
});

describe("job status normalization", () => {
  it("maps backend spellings onto the four phases", () => {
    expect(normalizeJobStatus("QUEUED")).toBe("queued");
    expect(normalizeJobStatus("processing")).toBe("processing");
    expect(normalizeJobStatus("COMPLETE")).toBe("completed");
    expect(normalizeJobStatus("succeeded")).toBe("completed");
    expect(normalizeJobStatus("Failed")).toBe("failed");
    expect(normalizeJobStatus("something-new")).toBeUndefined();
    expect(normalizeJobStatus(42)).toBeUndefined();
  });
});
