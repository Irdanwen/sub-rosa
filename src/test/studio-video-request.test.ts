import { beforeEach, describe, expect, it } from "vitest";
import { forgetLearnedConstraints } from "../lib/studio/model-constraints";
import type { MediaModel } from "../lib/studio/types";
import { inlineMediaInputs, videoRequestBody } from "../lib/studio/video-request";

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

describe("reference clips and audio (the seedance edit/extend/stitch inputs)", () => {
  const CLIP_A = "data:video/mp4;base64,QUFB";
  const CLIP_B = "data:video/mp4;base64,QkJC";
  const VOICE = "data:audio/mpeg;base64,Vk9JQ0U=";

  it("sends clips in order with the combined duration the quote needs", () => {
    const body = videoRequestBody({
      target: REF2V,
      prompt: "Extend <Video 1>, generate a chase",
      referenceVideos: [CLIP_A, CLIP_B],
      referenceVideoSeconds: [5, 7.4],
    });
    expect(body?.reference_video_urls).toEqual([CLIP_A, CLIP_B]);
    // Rounded: the field is an integer count of seconds.
    expect(body?.reference_video_total_duration).toBe(12);
  });

  it("caps clips at what the version documents", () => {
    const many = [CLIP_A, CLIP_B, CLIP_A, CLIP_B];
    const body = videoRequestBody({
      target: REF2V,
      prompt: "<Video 1> + a transition + followed by <Video 2>",
      referenceVideos: many,
    });
    // Seedance 2.0 takes three clips, not four.
    expect((body?.reference_video_urls as string[]).length).toBe(3);
  });

  it("refuses to send audio as the only reference, which the contract forbids", () => {
    const alone = videoRequestBody({
      target: REF2V,
      prompt: "Refer to the timbre in <Audio 1>",
      referenceAudio: [VOICE],
    });
    // Nothing visual: not a runnable reference request at all.
    expect(alone).toBeUndefined();

    const paired = videoRequestBody({
      target: REF2V,
      prompt: "Refer to <Subject 1> in <Image 1>, and the timbre in <Audio 1>",
      references: [REF_A],
      referenceAudio: [VOICE],
    });
    expect(paired?.reference_audio_urls).toEqual([VOICE]);
  });

  it("keeps reference media off the variants that have no such contract", () => {
    const imageToVideo = videoRequestBody({
      target: I2V,
      prompt: "the keeper turns",
      openingFrame: FRAME,
      referenceVideos: [CLIP_A],
      referenceAudio: [VOICE],
    });
    expect(imageToVideo?.reference_video_urls).toBeUndefined();
    expect(imageToVideo?.reference_audio_urls).toBeUndefined();

    const otherFamily = videoRequestBody({
      target: m("wan-2-7-reference-to-video"),
      prompt: "a scene",
      references: [REF_A],
      referenceVideos: [CLIP_A],
    });
    expect(otherFamily?.reference_video_urls).toBeUndefined();
  });

  it("lets a clip alone drive a reference render (extend needs no photo)", () => {
    const body = videoRequestBody({
      target: REF2V,
      prompt: "Extend <Video 1>, generate a chase",
      referenceVideos: [CLIP_A],
    });
    expect(body).toBeDefined();
    expect(body?.reference_image_urls).toBeUndefined();
  });

  it("lists every inline input a body carries, so the size cap sees all of them", () => {
    // Each input can be within its own limit and the body still be over the
    // shared cap. Measuring one field at a time misses exactly that case.
    const body = videoRequestBody({
      target: REF2V,
      prompt: "Refer to <Subject 1> in <Image 1>, following <Audio 1>",
      openingFrame: FRAME,
      references: [REF_A, REF_B],
      referenceVideos: [CLIP_A],
      referenceAudio: [VOICE],
    });
    expect(inlineMediaInputs(body ?? {}).sort()).toEqual(
      [FRAME, REF_A, REF_B, CLIP_A, VOICE].sort(),
    );
  });

  it("finds nothing to measure in a text-to-video body", () => {
    const body = videoRequestBody({ target: T2V, prompt: "a fox in the rain" });
    expect(inlineMediaInputs(body ?? {})).toEqual([]);
  });

  it("attests for a clip-driven render, not only a photo-driven one", () => {
    // A clip shows a person as readily as a photo does. Leaving the attestation
    // off an "Extend <Video 1>" render earned a 409 for consent the user had
    // already given.
    const body = videoRequestBody({
      target: REF2V,
      prompt: "Extend <Video 1>, generate a chase",
      referenceVideos: [CLIP_A],
      consent: true,
    });
    expect(body?.consents).toBeDefined();
  });

  it("drops clips a model declares it does not take, and keeps its audio", () => {
    // The public tier publishes `video_input: false` while its family's guide
    // describes the clip workflows at length. Whatever a surface offered, the
    // body is what the model will actually be billed for, so it decides here.
    const basic = m("seedance-2-5-reference-to-video-basic", {
      video_input: false,
      audio_input: true,
    });
    const body = videoRequestBody({
      target: basic,
      prompt: "Refer to <Subject 1> in <Image 1> to generate a chase",
      references: [REF_A],
      referenceVideos: [CLIP_A],
      referenceAudio: [VOICE],
    });
    expect(body?.reference_video_urls).toBeUndefined();
    expect(body?.reference_video_total_duration).toBeUndefined();
    expect(body?.reference_audio_urls).toEqual([VOICE]);
  });

  it("will not build a clip-only render for a model that takes no clips", () => {
    // Nothing visual left once the clips are dropped, so there is no render to
    // make - better an inert button than a queued request that cannot work.
    const basic = m("seedance-2-5-reference-to-video-basic", { video_input: false });
    expect(
      videoRequestBody({
        target: basic,
        prompt: "Extend <Video 1>, generate a chase",
        referenceVideos: [CLIP_A],
      }),
    ).toBeUndefined();
  });
});
