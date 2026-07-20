// Seedance face-media consent.
//
// Venice's seedance image/reference-to-video endpoint refuses any reference
// photo that contains a human face with a `409 needs_consent` until the caller
// attests to the seedance face-media policy. Carpe Diem forwards the video
// queue body to Venice verbatim, so the same gate applies through the fork's
// media proxy. We cannot detect faces inside the webview, so the studios ask
// once, remember the acknowledgement, and forward the attestation Venice
// requires on every seedance render built from a reference.

import { isSeedanceModel } from "./catalog";
import type { MediaModel } from "./types";

/** Remembered so the user attests once, not on every render. */
const CONSENT_STORAGE_KEY = "os-june:seedance-consent";

/** The attestation body Venice's seedance face-media policy requires. All
 * three flags must be `true`. The object is optional in Venice's schema and
 * safely ignored by any request that does not need it, so it only ever rides
 * on the seedance reference renders that would otherwise `409`. */
export const SEEDANCE_CONSENT = {
  consents: {
    seedance: {
      confirmed_terms_and_privacy: true,
      confirmed_legal_right: true,
      confirmed_screening_acknowledged: true,
    },
  },
} as const;

/** Whether a queued render must carry the seedance consent: a seedance model
 * driven by a reference photo (image- or reference-to-video). Text-to-video
 * has no face-bearing input, so it never needs it. */
export function needsSeedanceConsent(
  model: MediaModel | undefined,
  hasReference: boolean,
): boolean {
  return Boolean(model && hasReference && isSeedanceModel(model.id));
}

/** Merges the consent attestation into a queue body without mutating it. */
export function withSeedanceConsent(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, ...SEEDANCE_CONSENT };
}

export function hasSeedanceConsent(): boolean {
  try {
    return window.localStorage.getItem(CONSENT_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function rememberSeedanceConsent(accepted: boolean): void {
  try {
    if (accepted) window.localStorage.setItem(CONSENT_STORAGE_KEY, "true");
    else window.localStorage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // Best-effort: a blocked store just re-asks on the next launch.
  }
}
