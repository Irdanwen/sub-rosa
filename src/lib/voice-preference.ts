// One voice for everything Sub Rosa reads aloud: a chat reply (reply-speech.ts),
// a note's spoken recap (note-speech.ts), and the voice conversation when it
// comes. The person picks an engine and one of its voices in Settings ›
// Personalization, on either shell, and every reader asks this module what to
// speak with instead of each picking its own default.
//
// Kept on this device (localStorage): it is a taste, not data, and a voice
// one device offers another may not. A choice the catalog no longer honours
// (an engine gone offline, a voice the engine dropped) falls back to the
// default engine and its default voice rather than failing the reading.
//
// Only one-call engines (the `/audio/speech` rail): reading aloud plays now,
// and a queued engine takes minutes (ADR-0076).

import { useSyncExternalStore } from "react";
import { fetchMediaCatalog, modelsOfType, speechRail } from "./studio/catalog";
import {
  acceptedVoice,
  defaultSpeechModel,
  generateSpeech,
  type SpeechFormat,
  speechCapabilities,
} from "./studio/speech";
import type { MediaModel } from "./studio/types";

const STORAGE_KEY = "subrosa:voice-preference";

export type VoicePreference = {
  /** The engine's model id. Absent: the default engine. */
  model?: string;
  /** One of that engine's voices. Absent: its default voice. */
  voice?: string;
};

const listeners = new Set<() => void>();
let snapshot: VoicePreference | undefined;

function parse(raw: string | null): VoicePreference {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const text = (field: unknown) =>
      typeof field === "string" && field.trim() ? field.trim() : undefined;
    const model = text(value.model);
    const voice = text(value.voice);
    return { ...(model ? { model } : {}), ...(voice ? { voice } : {}) };
  } catch {
    return {};
  }
}

export function readVoicePreference(): VoicePreference {
  if (snapshot) return snapshot;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (a private window): the default voice reads.
  }
  snapshot = parse(raw);
  return snapshot;
}

export function setVoicePreference(next: VoicePreference) {
  snapshot = parse(JSON.stringify(next));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Kept for this session only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The stored choice, kept current across every screen that shows it. */
export function useVoicePreference(): VoicePreference {
  return useSyncExternalStore(subscribe, readVoicePreference, readVoicePreference);
}

/** Identifies what a reading sounds like, so audio rendered in one voice is
 * never replayed after the person picked another. */
export function voicePreferenceKey(preference = readVoicePreference()): string {
  return `${preference.model ?? ""}|${preference.voice ?? ""}`;
}

/** The engines a text can be read aloud with. */
export function readAloudEngines(models: readonly MediaModel[]): MediaModel[] {
  return models.filter((model) => !model.offline && speechRail(model) === "speech");
}

export async function fetchReadAloudEngines(): Promise<MediaModel[]> {
  return readAloudEngines(modelsOfType(await fetchMediaCatalog(), "tts"));
}

export type SpeechVoice = {
  engine: MediaModel;
  /** Undefined when the engine takes no voice. */
  voice?: string;
  voices: string[];
  format: SpeechFormat;
};

/** What a text is read with: the chosen engine while the catalog still offers
 * it, else the cheapest one-call engine, and the chosen voice where that
 * engine takes it, else its own default. */
export function resolveSpeechVoice(
  models: readonly MediaModel[],
  preference: VoicePreference = readVoicePreference(),
): SpeechVoice | undefined {
  const engines = readAloudEngines(models);
  const engine =
    engines.find((model) => model.id === preference.model) ?? defaultSpeechModel(engines);
  if (!engine) return undefined;
  const caps = speechCapabilities(engine);
  return {
    engine,
    voice: acceptedVoice(caps, preference.voice),
    voices: caps.voices,
    format: caps.defaultFormat,
  };
}

/**
 * Renders `text` in the preferred voice into a playable Blob URL. Never a
 * data: URL: WKWebView byte-range-requests media and leaves a data: audio
 * silent. Rejects when no engine can read it.
 */
export async function renderPreferredSpeech(
  text: string,
  options: { signal?: AbortSignal; preference?: VoicePreference } = {},
): Promise<string> {
  const preference = options.preference ?? readVoicePreference();
  const chosen = resolveSpeechVoice(await fetchReadAloudEngines(), preference);
  if (!chosen) throw new Error("no speech model");
  const { base64, contentType } = await generateSpeech({
    model: chosen.engine.id,
    input: text,
    // No voice asked for, none sent: the engine reads in its own default.
    voice: preference.voice ? chosen.voice : undefined,
    format: chosen.format,
    signal: options.signal,
  });
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: contentType || "audio/mpeg" }));
}

/** Forgets the cached choice, for tests that change storage underneath. */
export function resetVoicePreferenceForTests() {
  snapshot = undefined;
}
