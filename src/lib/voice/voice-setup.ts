// What a voice conversation is set up with, read where every other reader
// reads it: the engine and voice of Settings › Personalization
// (voice-preference.ts), and the transcription model of Settings, for the
// price said before the first conversation.

import { clonedVoiceHandle, clonedVoiceId } from "../studio/cloned-voices";
import { fetchMediaCatalog, modelsOfType } from "../studio/catalog";
import type { MediaModel } from "../studio/types";
import { providerModelSettings } from "../tauri";
import {
  fetchReadAloudEngines,
  readVoicePreference,
  resolveSpeechVoice,
  type VoicePreference,
} from "../voice-preference";
import { type VoiceCost, voiceCostPerMinute } from "./voice-cost";
import type { VoiceSpeech } from "./voice-session";

/** The parakeet model the transcription settings default to. */
const DEFAULT_TRANSCRIPTION_MODEL = "nvidia/parakeet-tdt-0.6b-v3";

/** The speech settings the session renders with, or null when no engine can
 * read aloud. A cloned voice is resolved to its handle now. */
export async function resolveVoiceSpeech(
  preference: VoicePreference = readVoicePreference(),
  engines?: MediaModel[],
): Promise<VoiceSpeech | null> {
  const chosen = resolveSpeechVoice(engines ?? (await fetchReadAloudEngines()), preference);
  if (!chosen) return null;
  // No voice asked for, none sent: the engine reads in its own default.
  let voice = preference.voice ? chosen.voice : undefined;
  const cloned = clonedVoiceId(voice);
  if (cloned) voice = await clonedVoiceHandle(cloned);
  return { model: chosen.engine.id, format: chosen.format, ...(voice ? { voice } : {}) };
}

/** The price of a minute of conversation, from the live catalog. */
export async function fetchVoiceCost(): Promise<VoiceCost> {
  const catalog = await fetchMediaCatalog();
  const transcriptionId = await providerModelSettings()
    .then((response) => response.settings.transcriptionModel)
    .catch(() => DEFAULT_TRANSCRIPTION_MODEL);
  const engine = resolveSpeechVoice(modelsOfType(catalog, "tts"))?.engine;
  const transcription = modelsOfType(catalog, "asr").find((model) => model.id === transcriptionId);
  return voiceCostPerMinute({ speechEngine: engine, transcriptionModel: transcription });
}
