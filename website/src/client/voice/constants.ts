/** The voice loop's numbers, as Rust exports them (`web_features/voice.rs`). */
import exported from "@subrosa/chat-core/web/voice.json";

export interface VoiceExport {
  sampleRate: number;
  frameSamples: number;
  vad: {
    minSpeechDb: number;
    aboveFloorDb: number;
    hysteresisDb: number;
    onsetMs: number;
    bargeInOnsetMs: number;
    endSilenceMs: number;
    minVoicedMs: number;
    maxUtteranceMs: number;
    preRollMs: number;
    echoCouplingDb: number;
    echoMarginDb: number;
  };
  echoCancelledCouplingDb: number;
  echoTailMs: number;
  sentences: { minChars: number; maxChars: number };
  frame: { longestSide: number; jpegQuality: number };
}
export const VOICE = exported as VoiceExport;
