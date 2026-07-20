import { beforeEach, describe, expect, it } from "vitest";
import {
  hasSeedanceConsent,
  needsSeedanceConsent,
  rememberSeedanceConsent,
  SEEDANCE_CONSENT,
  withSeedanceConsent,
} from "../lib/studio/consent";
import type { MediaModel } from "../lib/studio/types";

function model(id: string): MediaModel {
  return { id, name: id, mediaType: "imageToVideo", offline: false };
}

describe("seedance consent gating", () => {
  it("only needs consent for a seedance model driven by a reference", () => {
    // seedance + a reference photo (image- or reference-to-video)
    expect(needsSeedanceConsent(model("seedance-2-0-image-to-video"), true)).toBe(true);
    // seedance without a reference (text-to-video) never needs it
    expect(needsSeedanceConsent(model("seedance-2-0-text-to-video"), false)).toBe(false);
    // a reference render on any other family never needs it
    expect(needsSeedanceConsent(model("wan-2-7-image-to-video"), true)).toBe(false);
    // no model selected yet
    expect(needsSeedanceConsent(undefined, true)).toBe(false);
  });

  it("merges the three-flag attestation without mutating the body", () => {
    const body = { model: "seedance-2-0-image-to-video", prompt: "hi", image_url: "data:," };
    const withConsent = withSeedanceConsent(body);
    expect(withConsent.consents).toEqual(SEEDANCE_CONSENT.consents);
    expect(SEEDANCE_CONSENT.consents.seedance).toEqual({
      confirmed_terms_and_privacy: true,
      confirmed_legal_right: true,
      confirmed_screening_acknowledged: true,
    });
    // original untouched, and the payload fields survive the merge
    expect("consents" in body).toBe(false);
    expect(withConsent.image_url).toBe("data:,");
  });
});

describe("remembered consent", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips the acknowledgement and clears it on withdrawal", () => {
    expect(hasSeedanceConsent()).toBe(false);
    rememberSeedanceConsent(true);
    expect(hasSeedanceConsent()).toBe(true);
    rememberSeedanceConsent(false);
    expect(hasSeedanceConsent()).toBe(false);
  });
});
