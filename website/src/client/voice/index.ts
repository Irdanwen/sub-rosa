/**
 * The web client's voice conversation (ADR-0093), run in the page around the
 * open chat's own turns. It is a composer control, not a panel.
 */
import type { WebFeature } from "../feature";
import { VoiceControl } from "./VoiceControl";

export const voiceFeature: WebFeature = {
  id: "voice",
  ComposerControl: VoiceControl,
};
