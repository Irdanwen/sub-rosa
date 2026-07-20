import { describe, expect, it } from "vitest";
import { normalizeJobStatus } from "../lib/studio/async-job";
import {
  defaultEditModel,
  estimateCostCredits,
  imageEditModels,
  isSoundEffectsModel,
  musicCapabilities,
  musicModels,
  soundEffectsModels,
  supportsBackgroundRemoval,
  videoFamilies,
  videoFamilyKey,
  withVideoDurationFallbacks,
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
});

describe("video duration fallbacks", () => {
  it("fills durations for seedance models the catalogs never constrain", () => {
    const patched = withVideoDurationFallbacks(
      catalog([
        model({ id: "seedance-2-0-image-to-video", mediaType: "imageToVideo" }),
        model({ id: "seedance-1-5-pro-text-to-video", mediaType: "video" }),
        model({ id: "wan-2-7-text-to-video", mediaType: "video" }),
      ]),
    );
    const byId = new Map(patched.models.map((entry) => [entry.id, entry]));
    const seedance2 = byId.get("seedance-2-0-image-to-video")?.constraints?.durations;
    expect(seedance2?.[0]).toBe("4s");
    expect(seedance2?.at(-1)).toBe("15s");
    const seedance15 = byId.get("seedance-1-5-pro-text-to-video")?.constraints?.durations;
    expect(seedance15?.at(-1)).toBe("12s");
    // Unlisted families stay untouched (no fabricated menus).
    expect(byId.get("wan-2-7-text-to-video")?.constraints).toBeUndefined();
  });

  it("never overrides durations the live catalog already publishes", () => {
    const patched = withVideoDurationFallbacks(
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
