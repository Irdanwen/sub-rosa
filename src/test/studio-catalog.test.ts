import { describe, expect, it } from "vitest";
import { normalizeJobStatus } from "../lib/studio/async-job";
import {
  estimateCostCredits,
  musicCapabilities,
  videoFamilies,
  videoFamilyKey,
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
