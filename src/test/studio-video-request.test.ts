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

describe("kling reference renders", () => {
  const KLING = m("kling-o3-pro-reference-to-video");
  const refs = (count: number) =>
    Array.from({ length: count }, (_, index) => `data:image/jpeg;base64,R${index + 1}`);

  it("runs on references alone, sent as elements", () => {
    // Kling reads no `reference_image_urls`: handed only that field it saw no
    // visual input and refused the render ("At least one visual input is
    // required: image_url, elements, or scene_image_urls", measured
    // 2026-10-01). That refusal was once read as "needs an opening frame".
    const body = videoRequestBody({
      target: KLING,
      prompt: "@Element1 walks through the fog",
      references: [REF_A],
    });
    expect(body?.elements).toEqual([{ frontal_image_url: REF_A }]);
    expect(body).not.toHaveProperty("reference_image_urls");
    expect(body).not.toHaveProperty("scene_image_urls");
    expect(body).not.toHaveProperty("image_url");
  });

  it("puts the first four in elements and the next four in scene images", () => {
    const body = videoRequestBody({ target: KLING, prompt: "a scene", references: refs(6) });
    expect(body?.elements).toEqual(refs(4).map((frontal) => ({ frontal_image_url: frontal })));
    expect(body?.scene_image_urls).toEqual(refs(6).slice(4));
  });

  it("drops what neither cap can carry", () => {
    const body = videoRequestBody({ target: KLING, prompt: "a scene", references: refs(10) });
    expect(body?.elements).toHaveLength(4);
    expect(body?.scene_image_urls).toEqual(refs(8).slice(4));
  });

  it("still takes an opening frame next to the references", () => {
    const body = videoRequestBody({
      target: KLING,
      prompt: "she walks through the fog",
      openingFrame: FRAME,
      references: [REF_A],
    });
    expect(body?.image_url).toBe(FRAME);
    expect(body?.elements).toEqual([{ frontal_image_url: REF_A }]);
  });

  it("measures the images nested in elements", () => {
    const body = videoRequestBody({ target: KLING, prompt: "a scene", references: refs(5) });
    expect(body && [...inlineMediaInputs(body)].sort()).toEqual(refs(5));
  });

  it("groups a subject's angles into one element and sends scenes as scene images", () => {
    const body = videoRequestBody({
      target: KLING,
      prompt: "@Element1 crosses @Image1",
      references: refs(4),
      referenceRoles: [
        { subject: "Nera" },
        { subject: "Nera" },
        { scene: true },
        { subject: "Ivo" },
      ],
    });
    expect(body?.elements).toEqual([
      { frontal_image_url: refs(1)[0], reference_image_urls: [refs(2)[1]] },
      { frontal_image_url: refs(4)[3] },
    ]);
    expect(body?.scene_image_urls).toEqual([refs(3)[2]]);
  });

  it("ignores the roles on every other family", () => {
    const body = videoRequestBody({
      target: REF2V,
      prompt: "a scene",
      references: [REF_A, REF_B],
      referenceRoles: [{ subject: "Nera" }, { scene: true }],
    });
    expect(body?.reference_image_urls).toEqual([REF_A, REF_B]);
  });

  it("still refuses a kling V3 reference render with no opening frame", () => {
    // Measured 2026-10-01: V3 wants "image_url" whatever else it is given.
    const v3 = m("kling-v3-4k-reference-to-video");
    expect(
      videoRequestBody({ target: v3, prompt: "a scene", references: [REF_A] }),
    ).toBeUndefined();
    const body = videoRequestBody({
      target: v3,
      prompt: "a scene",
      openingFrame: FRAME,
      references: [REF_A],
    });
    expect(body?.image_url).toBe(FRAME);
    expect(body?.elements).toEqual([{ frontal_image_url: REF_A }]);
  });

  it("sends gemini omni flash no more than the three photos it takes", () => {
    const body = videoRequestBody({
      target: m("gemini-omni-flash-reference-to-video"),
      prompt: "a scene",
      references: refs(4),
    });
    expect(body?.reference_image_urls).toEqual(refs(3));
  });

  it("leaves seedance on the flat reference field", () => {
    const body = videoRequestBody({
      target: REF2V,
      prompt: "she walks through the fog",
      references: [REF_A],
    });
    expect(body?.reference_image_urls).toEqual([REF_A]);
    expect(body).not.toHaveProperty("elements");
  });
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
    expect(body?.reference_video_urls).toHaveLength(3);
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

describe("a silent render", () => {
  it("switches the sound off only on a model that publishes the switch", () => {
    // Measured 2026-10-05 against /video/quote: `audio` is a boolean the
    // operator validates ("Expected boolean, received string").
    const switchable = m("kling-v3-pro-text-to-video", { audio: true, audio_configurable: true });
    expect(
      videoRequestBody({ target: switchable, prompt: "Nera speaks.", silent: true })?.audio,
    ).toBe(false);
    // No switch published: an unknown key would fail the render, so it stays out.
    const fixed = m("minimax-h3-text-to-video", { audio: true });
    expect(
      videoRequestBody({ target: fixed, prompt: "Nera speaks.", silent: true }),
    ).not.toHaveProperty("audio");
    expect(videoRequestBody({ target: switchable, prompt: "Nera speaks." })).not.toHaveProperty(
      "audio",
    );
  });
});
