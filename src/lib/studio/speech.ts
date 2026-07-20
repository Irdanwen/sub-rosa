// Text-to-speech over the media proxy: one synchronous call that returns the
// audio bytes. Kept out of the components so desktop, mobile, and the workflow
// tts node share the exact request shape (`POST /audio/speech`, OpenAI-style).

import { mediaBinary } from "./client";

/** UI cap on the narration text. The backend accepts far more, but speech is
 * billed per character - a hard stop here keeps an accidental paste from
 * becoming an expensive render. */
export const SPEECH_INPUT_LIMIT = 5_000;

export const SPEECH_FORMATS = ["mp3", "wav", "flac"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

/** Playback-speed bounds the endpoint accepts. */
export const SPEECH_SPEED = { min: 0.25, max: 4, step: 0.25, default: 1 };

export interface SpeechRequest {
  model: string;
  input: string;
  voice?: string;
  speed?: number;
  format?: SpeechFormat;
  signal?: AbortSignal;
}

export async function generateSpeech(
  request: SpeechRequest,
): Promise<{ base64: string; contentType?: string }> {
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.input,
    speed: request.speed ?? SPEECH_SPEED.default,
    response_format: request.format ?? "mp3",
  };
  if (request.voice) body.voice = request.voice;
  return mediaBinary("/audio/speech", body, request.signal);
}
