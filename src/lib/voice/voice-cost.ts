// What a minute of voice conversation costs, said before the first one.
//
// A minute is taken as half the person speaking (transcribed by the
// second) and half the assistant reading (rendered by the character, at
// about fifteen characters a second). The chat replies themselves are
// priced like typed ones and depend on the model, so they are named, not
// added.

import { estimateCostCredits } from "../studio/catalog";
import type { MediaModel } from "../studio/types";

/** Seconds of the person's speech in a minute of conversation. */
export const HEARD_SECONDS_PER_MINUTE = 30;
/** Characters the assistant reads in a minute of conversation. */
export const SPOKEN_CHARACTERS_PER_MINUTE = 450;

export type VoiceCost = {
  /** Listening and speaking, in credits a minute, when the catalog prices both. */
  creditsPerMinute?: number;
};

export function voiceCostPerMinute(params: {
  speechEngine?: MediaModel;
  transcriptionModel?: MediaModel;
}): VoiceCost {
  const speaking = params.speechEngine
    ? estimateCostCredits(params.speechEngine, { characters: SPOKEN_CHARACTERS_PER_MINUTE })
    : undefined;
  const listening = params.transcriptionModel
    ? estimateCostCredits(params.transcriptionModel, { durationSeconds: HEARD_SECONDS_PER_MINUTE })
    : undefined;
  if (speaking === undefined || listening === undefined) return {};
  return { creditsPerMinute: Math.round((speaking + listening) * 100) / 100 };
}
