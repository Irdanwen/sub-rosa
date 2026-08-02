import { beforeEach, describe, expect, it } from "vitest";
import { withVideoConstraintFallbacks } from "../lib/studio/catalog";
import {
  effectiveVideoConstraints,
  explainConstraintError,
  forgetLearnedConstraints,
  learnedConstraints,
  missingRequiredFields,
  parseConstraintError,
  probedConstraints,
  rememberConstraintError,
} from "../lib/studio/model-constraints";
import type { MediaCatalog, MediaModel } from "../lib/studio/types";

function model(overrides: Partial<MediaModel> & Pick<MediaModel, "id" | "mediaType">): MediaModel {
  return { name: overrides.id, offline: false, ...overrides };
}

/** The shape the app actually receives: the operator wraps the upstream Zod
 * report in a string and truncates it at ~200 characters. */
const RATIO_REQUIRED =
  'HTTP 400 (raw: {"details":{"_errors":[],"aspect_ratio":{"_errors":["Required"]}},"issues":[{"expected":"\'21:9\' | \'16:9\' | \'4:3\' | \'1:1\' | \'3:4\' | \'9:16\'","received":"undefined","code":"invalid_type","path":["aspect_)';

const RATIO_ENUM =
  'HTTP 400 (raw: {"details":{"_errors":[],"aspect_ratio":{"_errors":["Invalid enum value. Expected \'21:9\' | \'16:9\' | \'4:3\' | \'1:1\' | \'3:4\' | \'9:16\', received \'99:1\'"]}},"issues":[{"received":"99:1"';

/** Escaped variant: the same report nested one JSON level deeper. */
const DURATION_ENUM_ESCAPED =
  'HTTP 400 (raw: {\\"details\\":{\\"_errors\\":[],\\"duration\\":{\\"_errors\\":[\\"Invalid enum value. Expected \'5s\' | \'10s\', received \'zzz\'\\"]}}';

beforeEach(() => {
  forgetLearnedConstraints();
});

describe("probed fallbacks", () => {
  it("knows the families the catalog is silent about", () => {
    expect(probedConstraints("seedance-2-0-reference-to-video")?.durations?.at(-1)).toBe("15s");
    expect(probedConstraints("seedance-2-0-reference-to-video")?.aspectRatios).toContain("9:16");
    // The 1.5 pro entry must win over the generic seedance one.
    expect(probedConstraints("seedance-1-5-pro-image-to-video")?.durations?.at(-1)).toBe("12s");
    // The reference variant takes a shorter list than the image one.
    expect(probedConstraints("wan-2-7-reference-to-video")?.durations).toEqual(["5s", "10s"]);
    expect(probedConstraints("wan-2-7-image-to-video")?.durations).toEqual(["5s", "10s", "15s"]);
    expect(probedConstraints("veo3-fast-text-to-video")).toBeUndefined();
  });

  it("fills only the holes, never overrides what the catalog published", () => {
    const catalog: MediaCatalog = {
      backend: "carpe-diem",
      models: [
        model({ id: "seedance-2-0-reference-to-video", mediaType: "referenceToVideo" }),
        model({
          id: "seedance-2-0-image-to-video",
          mediaType: "imageToVideo",
          // A published list must survive untouched.
          constraints: { aspect_ratios: ["16:9"], durations: ["5s"] },
        }),
        model({ id: "some-image-model", mediaType: "image" }),
      ],
    };
    const patched = withVideoConstraintFallbacks(catalog);
    const byId = new Map(patched.models.map((entry) => [entry.id, entry]));

    const filled = byId.get("seedance-2-0-reference-to-video")?.constraints;
    expect(filled?.aspect_ratios).toContain("21:9");
    expect(filled?.durations?.at(-1)).toBe("15s");
    expect(filled?.resolutions).toContain("1080p");

    const published = byId.get("seedance-2-0-image-to-video")?.constraints;
    expect(published?.aspect_ratios).toEqual(["16:9"]);
    expect(published?.durations).toEqual(["5s"]);
    // The hole in a partially published model still gets filled.
    expect(published?.resolutions).toContain("720p");

    expect(byId.get("some-image-model")?.constraints).toBeUndefined();
  });
});

describe("learning from a rejection", () => {
  it("reads the enum the provider says it wanted", () => {
    expect(parseConstraintError(RATIO_ENUM).aspectRatios).toEqual([
      "21:9",
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16",
    ]);
    expect(parseConstraintError(DURATION_ENUM_ESCAPED).durations).toEqual(["5s", "10s"]);
  });

  it("reads which fields were required", () => {
    expect(parseConstraintError(RATIO_REQUIRED).required).toEqual(["aspect_ratio"]);
  });

  it("ignores anything that is not one of these reports", () => {
    expect(parseConstraintError("Upstream provider failed")).toEqual({});
    expect(parseConstraintError("")).toEqual({});
    // A field we do not drive a picker for must not be mistaken for one.
    expect(parseConstraintError('{"details":{"seed":{"_errors":["Unrecognized key"]}}}')).toEqual(
      {},
    );
  });

  it("remembers per model, and lets what it learned win over the probes", () => {
    const learned = rememberConstraintError("wan-2-7-reference-to-video", DURATION_ENUM_ESCAPED);
    expect(learned.durations).toEqual(["5s", "10s"]);
    expect(learnedConstraints("wan-2-7-reference-to-video")?.durations).toEqual(["5s", "10s"]);
    // Another model is unaffected.
    expect(learnedConstraints("seedance-2-0-reference-to-video")).toBeUndefined();
  });

  it("beats both the published catalog and the probed table", () => {
    rememberConstraintError("seedance-2-0-reference-to-video", RATIO_ENUM);
    const constraints = effectiveVideoConstraints(
      model({
        id: "seedance-2-0-reference-to-video",
        mediaType: "referenceToVideo",
        constraints: { aspect_ratios: ["16:9"] },
      }),
    );
    expect(constraints.aspect_ratios).toContain("21:9");
  });

  it("falls back to published, then probed, field by field", () => {
    const constraints = effectiveVideoConstraints(
      model({
        id: "seedance-2-0-image-to-video",
        mediaType: "imageToVideo",
        constraints: { durations: ["7s"] },
      }),
    );
    expect(constraints.durations).toEqual(["7s"]);
    expect(constraints.aspect_ratios).toContain("16:9");
    expect(effectiveVideoConstraints(undefined)).toEqual({});
  });
});

describe("explaining a rejection", () => {
  it("turns the schema dump into a sentence naming the fix", () => {
    const message = explainConstraintError(RATIO_REQUIRED);
    expect(message).toContain("aspect ratio");
    expect(message).not.toContain("_errors");
  });

  it("lists the values that would work", () => {
    expect(explainConstraintError(RATIO_ENUM)).toContain("16:9");
  });

  it("says nothing about an error it does not understand, so it shows as-is", () => {
    expect(explainConstraintError("Upstream provider failed")).toBeUndefined();
  });
});

describe("learning from a missing field", () => {
  it("takes the enum out of the Required report, so one rejection is enough", () => {
    // This is verbatim what the user's failing render returned: the field is
    // reported as missing, and the enum it wanted rides along in `issues`.
    const learned = parseConstraintError(RATIO_REQUIRED);
    expect(learned.required).toEqual(["aspect_ratio"]);
    expect(learned.aspectRatios).toEqual(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  });

  it("matches the field even though the operator truncates the path", () => {
    // "path":["aspect_ ... — cut off mid-word by the 200-char ceiling.
    expect(RATIO_REQUIRED).toContain('"path":["aspect_)');
    expect(parseConstraintError(RATIO_REQUIRED).aspectRatios).toBeDefined();
  });

  it("does not let the issues block override a precise details block", () => {
    const learned = parseConstraintError(RATIO_ENUM);
    expect(learned.aspectRatios).toEqual(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  });
});

describe("required-field guard", () => {
  it("reports only what a provider actually complained about", () => {
    expect(missingRequiredFields("unknown-model", {})).toEqual([]);
    rememberConstraintError("seedance-2-0-reference-to-video", RATIO_REQUIRED);
    expect(missingRequiredFields("seedance-2-0-reference-to-video", { prompt: "x" })).toEqual([
      "aspect_ratio",
    ]);
  });

  it("is satisfied once the field is carried", () => {
    rememberConstraintError("seedance-2-0-reference-to-video", RATIO_REQUIRED);
    expect(
      missingRequiredFields("seedance-2-0-reference-to-video", { aspect_ratio: "16:9" }),
    ).toEqual([]);
    // An empty string is not a value.
    expect(missingRequiredFields("seedance-2-0-reference-to-video", { aspect_ratio: "" })).toEqual([
      "aspect_ratio",
    ]);
  });
});
