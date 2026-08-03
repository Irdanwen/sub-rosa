import { beforeEach, describe, expect, it } from "vitest";
import { forgetLearnedConstraints } from "../lib/studio/model-constraints";
import type { MediaModel } from "../lib/studio/types";
import { videoRequestBody } from "../lib/studio/video-request";

function m(id: string, constraints?: MediaModel["constraints"]): MediaModel {
  return { id, name: id, mediaType: "video", offline: false, constraints };
}

const REF2V = m("seedance-2-0-reference-to-video");
const I2V = m("seedance-2-0-image-to-video");
const T2V = m("seedance-2-0-text-to-video");
const UPSCALE = m("topaz-video-upscale");
const V2V = m("wan-2-7-video-to-video");

const FRAME = "data:image/jpeg;base64,FRAME";
const REF_A = "data:image/jpeg;base64,AAA";
const REF_B = "data:image/jpeg;base64,BBB";

beforeEach(() => {
  forgetLearnedConstraints();
});

describe("a shot built from cumulative inputs", () => {
  it("carries the opening frame AND the references together", () => {
    // The whole point of the change: continuing a shot while keeping a
    // character sheet in play. Only the reference contract takes both.
    const body = videoRequestBody({
      target: REF2V,
      prompt: "she keeps walking",
      openingFrame: FRAME,
      references: [REF_A, REF_B],
    });
    expect(body?.image_url).toBe(FRAME);
    expect(body?.reference_image_urls).toEqual([REF_A, REF_B]);
  });

  it("sends only the frame to a variant that cannot take references", () => {
    // Dropping them silently is what the UI warns about; the body must not
    // smuggle an unrecognised key, which the provider rejects outright.
    const body = videoRequestBody({
      target: I2V,
      prompt: "she keeps walking",
      openingFrame: FRAME,
      references: [REF_A],
    });
    expect(body?.image_url).toBe(FRAME);
    expect(body?.reference_image_urls).toBeUndefined();
  });

  it("works from references with no opening frame", () => {
    const body = videoRequestBody({ target: REF2V, prompt: "a scene", references: [REF_A] });
    expect(body?.reference_image_urls).toEqual([REF_A]);
    expect(body?.image_url).toBeUndefined();
  });

  it("carries an end frame when one is set", () => {
    const body = videoRequestBody({
      target: I2V,
      prompt: "morph",
      openingFrame: FRAME,
      endFrame: REF_B,
    });
    expect(body?.end_image_url).toBe(REF_B);
  });

  it("refuses a photo-driven variant with no photo, rather than queueing it", () => {
    expect(videoRequestBody({ target: REF2V, prompt: "a scene" })).toBeUndefined();
    expect(videoRequestBody({ target: I2V, prompt: "a scene" })).toBeUndefined();
    // Text to video is the one that legitimately needs nothing.
    expect(videoRequestBody({ target: T2V, prompt: "a scene" })?.model).toBe(
      "seedance-2-0-text-to-video",
    );
  });

  it("refuses an empty prompt, except when upscaling", () => {
    expect(videoRequestBody({ target: T2V, prompt: "   " })).toBeUndefined();
    expect(
      videoRequestBody({ target: UPSCALE, prompt: "", sourceVideo: "data:video/mp4;base64,V" }),
    ).toBeDefined();
  });
});

describe("settings a model is known to take", () => {
  it("always sends the fields the model has options for", () => {
    // seedance publishes nothing, so these come from the probed table - and
    // omitting aspect_ratio is exactly what the provider rejected.
    const body = videoRequestBody({
      target: REF2V,
      prompt: "a scene",
      references: [REF_A],
      duration: "15s",
      aspectRatio: "9:16",
      resolution: "1080p",
    });
    expect(body?.duration).toBe("15s");
    expect(body?.aspect_ratio).toBe("9:16");
    expect(body?.resolution).toBe("1080p");
  });

  it("falls back to the model's first option rather than sending nothing", () => {
    const body = videoRequestBody({
      target: REF2V,
      prompt: "a scene",
      references: [REF_A],
      duration: "99s",
      aspectRatio: "42:1",
    });
    expect(body?.duration).toBe("4s");
    expect(body?.aspect_ratio).toBe("21:9");
  });

  it("sends nothing for a field nobody knows about", () => {
    // An unrecognised key is refused as hard as a missing required one.
    const unknown = m("brand-new-model-text-to-video");
    const body = videoRequestBody({ target: unknown, prompt: "a scene", aspectRatio: "16:9" });
    expect(body?.aspect_ratio).toBeUndefined();
    expect(body?.duration).toBeUndefined();
  });
});

describe("the video surface", () => {
  it("builds the upscaler contract", () => {
    const body = videoRequestBody({
      target: UPSCALE,
      prompt: "",
      sourceVideo: "data:video/mp4;base64,V",
      upscaleFactor: 4,
    });
    expect(body).toMatchObject({
      video_url: "data:video/mp4;base64,V",
      upscale_factor: 4,
      duration: "Auto",
    });
    expect(videoRequestBody({ target: UPSCALE, prompt: "" })).toBeUndefined();
  });

  it("restyles from a source clip, never from an opening frame", () => {
    const body = videoRequestBody({
      target: V2V,
      prompt: "restyle it",
      sourceVideo: "data:video/mp4;base64,V",
      openingFrame: FRAME,
    });
    expect(body?.video_url).toBe("data:video/mp4;base64,V");
    expect(body?.image_url).toBeUndefined();
  });
});

describe("the face-media attestation", () => {
  it("rides along only for a seedance render actually built from a photo", () => {
    const withPhoto = videoRequestBody({
      target: REF2V,
      prompt: "a scene",
      references: [REF_A],
      consent: true,
    });
    expect(Object.keys(withPhoto ?? {}).length).toBeGreaterThan(4);

    // No photo, no attestation to make.
    const textOnly = videoRequestBody({ target: T2V, prompt: "a scene", consent: true });
    expect(JSON.stringify(textOnly)).not.toContain("consent");

    // Not given: nothing is asserted on the user's behalf.
    const withoutConsent = videoRequestBody({
      target: REF2V,
      prompt: "a scene",
      references: [REF_A],
      consent: false,
    });
    expect(JSON.stringify(withoutConsent)).not.toContain("consent");
  });
});
