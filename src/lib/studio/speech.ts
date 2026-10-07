// Text to speech on its two rails (ADR-0076). `tts` models answer
// `/audio/speech` in one call; the speaking models of the music queue
// (ElevenLabs TTS v3/v4, Seed Audio) are queued and retrieved like music,
// as a durable job (ADR-0018). Kept out of the components so desktop, mobile,
// the workflow tts node and the film share the exact request shapes.

import type { StartJobOptions } from "./async-job";
import { defaultVoice, modelVoices, speechRail, type SpeechRail } from "./catalog";
import { MediaError, mediaBinary } from "./client";
import { clonedVoiceHandle, clonedVoiceId } from "./cloned-voices";
import { musicPaths, retrieveBody } from "./paths";
import type { AudioConstraints, MediaCatalog, MediaModel } from "./types";

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
  // A cloned voice (ADR-0077) is resolved to its handle now, and reminted
  // once if the backend says the handle is gone (operator restart, retired
  // provider key): the sample is still on the device.
  const cloned = clonedVoiceId(request.voice);
  if (cloned) {
    body.voice = await clonedVoiceHandle(cloned);
    try {
      return await mediaBinary("/audio/speech", body, request.signal);
    } catch (error) {
      if (!(error instanceof MediaError) || error.status !== 404) throw error;
      body.voice = await clonedVoiceHandle(cloned, true);
      return mediaBinary("/audio/speech", body, request.signal);
    }
  }
  if (request.voice) body.voice = request.voice;
  return mediaBinary("/audio/speech", body, request.signal);
}

/** What a speaking model accepts, on whichever rail serves it. */
export interface SpeechCapabilities {
  rail: SpeechRail;
  voices: string[];
  defaultVoice?: string;
  /** Absent when the model takes no speed. */
  speed?: { min: number; max: number; step: number; default: number };
  /** Formats the request may ask for. The queue takes none: the model's own. */
  formats: readonly SpeechFormat[];
  /** What the model answers when nothing else is asked for. */
  defaultFormat: SpeechFormat;
  /** Set when the model makes a voice from a short sample (ADR-0077). */
  cloning?: { minSampleSeconds: number; acceptedFormats: string[]; retentionDays: number };
  inputLimit: number;
  /** `voice` also accepts the provider's own Voice ID (ElevenLabs). */
  customVoiceId: boolean;
  /** Bracketed expression tags the model performs instead of reading. No
   * catalog publishes this; ElevenLabs v3 and v4 document it. */
  audioTags: boolean;
}

/** Expression tags ElevenLabs v3 and v4 perform. Model syntax, not copy: the
 * model reads them in English whatever the text's language. */
export const AUDIO_TAGS = [
  "[whispers]",
  "[laughs]",
  "[sighs]",
  "[excited]",
  "[sarcastic]",
  "[curious]",
] as const;

export function speechCapabilities(model: MediaModel | undefined): SpeechCapabilities {
  const voices = modelVoices(model);
  const base = { voices, defaultVoice: defaultVoice(model) };
  const c = (model?.constraints ?? {}) as AudioConstraints;
  if (!model || speechRail(model) === "speech") {
    // Only the formats the model publishes: Chatterbox HD answers a 400 to
    // mp3 (measured 2026-10-07), and so would the other wav-only engines.
    const published = (c.supported_formats ?? []).filter((format): format is SpeechFormat =>
      (SPEECH_FORMATS as readonly string[]).includes(format),
    );
    const formats = published.length > 0 ? published : SPEECH_FORMATS;
    const defaultFormat = formats.find((format) => format === c.default_format) ?? formats[0];
    return {
      ...base,
      rail: "speech",
      speed: SPEECH_SPEED,
      formats,
      defaultFormat,
      cloning: cloningOf(c),
      inputLimit: SPEECH_INPUT_LIMIT,
      customVoiceId: false,
      audioTags: false,
    };
  }
  const min = c.min_speed ?? SPEECH_SPEED.min;
  const max = c.max_speed ?? SPEECH_SPEED.max;
  return {
    ...base,
    rail: "queue",
    speed:
      c.supports_speed === true
        ? {
            min,
            max,
            step: max - min <= 1 ? 0.05 : SPEECH_SPEED.step,
            default: Math.min(Math.max(c.default_speed ?? 1, min), max),
          }
        : undefined,
    formats: [],
    defaultFormat: "mp3",
    inputLimit: Math.min(SPEECH_INPUT_LIMIT, c.prompt_character_limit ?? SPEECH_INPUT_LIMIT),
    customVoiceId: c.supports_custom_voice_id === true,
    audioTags: /^elevenlabs-tts-v[34]/.test(model.id),
  };
}

/** The engine a speech surface opens on: a one-call model (seconds, not a
 * queued render of minutes), the cheapest the catalog prices. Never the first
 * name in the alphabet - that put a queued, premium engine in front of every
 * first narration, the default nobody chose (Carpe Diem #312 made the same
 * mistake). */
export function defaultSpeechModel(models: readonly MediaModel[]): MediaModel | undefined {
  const price = (model: MediaModel) => {
    const usd = (model.pricing?.input as { usd?: unknown } | undefined)?.usd;
    return typeof usd === "number" && Number.isFinite(usd) ? usd : Number.POSITIVE_INFINITY;
  };
  const oneCall = models.filter((model) => speechRail(model) === "speech");
  return (
    [...oneCall].sort((a, b) => price(a) - price(b) || a.name.localeCompare(b.name))[0] ?? models[0]
  );
}

function cloningOf(c: AudioConstraints): SpeechCapabilities["cloning"] {
  const raw = c.voice_cloning;
  if (!raw || typeof raw !== "object") return undefined;
  return {
    minSampleSeconds: typeof raw.min_sample_seconds === "number" ? raw.min_sample_seconds : 5,
    acceptedFormats: Array.isArray(raw.accepted_formats)
      ? raw.accepted_formats.filter((format): format is string => typeof format === "string")
      : ["mp3", "wav", "flac", "mp4"],
    retentionDays: typeof raw.retention_days === "number" ? raw.retention_days : 7,
  };
}

/** A format the model answers in: the one asked for when it takes it, else
 * its own default. */
export function acceptedFormat(
  caps: SpeechCapabilities,
  format: SpeechFormat | undefined,
): SpeechFormat {
  return format && caps.formats.includes(format) ? format : caps.defaultFormat;
}

/** A voice the model will take: one of its own, a provider Voice ID where it
 * accepts one, else its default. Never a name carried over from another
 * model, which the queue refuses. */
export function acceptedVoice(
  caps: SpeechCapabilities,
  voice: string | undefined,
): string | undefined {
  const wanted = voice?.trim();
  if (wanted && caps.voices.includes(wanted)) return wanted;
  if (wanted && caps.customVoiceId && isProviderVoiceId(wanted)) return wanted;
  // A cloned voice (`cloned:<id>`) on the engine that clones (ADR-0077).
  if (wanted && caps.cloning && clonedVoiceId(wanted)) return wanted;
  return caps.defaultVoice;
}

/** An ElevenLabs Voice ID: twenty-odd letters and digits. Anything else (a
 * name like `af_sky` kept from another model) is not one, and would be paid
 * for and refused. */
export function isProviderVoiceId(value: string): boolean {
  return /^[A-Za-z0-9]{16,40}$/.test(value.trim());
}

export function acceptedSpeed(
  caps: SpeechCapabilities,
  speed: number | undefined,
): number | undefined {
  if (!caps.speed) return undefined;
  const wanted = speed ?? caps.speed.default;
  return Math.min(Math.max(wanted, caps.speed.min), caps.speed.max);
}

export interface QueuedSpeechRequest {
  model: MediaModel;
  text: string;
  voice?: string;
  speed?: number;
}

/** The queue body: the text is the prompt the model reads aloud. Speed goes
 * out only where the model takes one, and never at its default. */
export function speechQueueBody(
  caps: SpeechCapabilities,
  request: QueuedSpeechRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model.id,
    prompt: request.text.trim().slice(0, caps.inputLimit),
  };
  const voice = acceptedVoice(caps, request.voice);
  if (voice) body.voice = voice;
  const speed = acceptedSpeed(caps, request.speed);
  if (speed !== undefined && speed !== caps.speed?.default) body.speed = speed;
  return body;
}

/** A queued narration as a durable job: Rust polls, downloads and notifies,
 * so locking the phone does not lose a render already paid for. */
export function queuedSpeechJob(
  catalog: Pick<MediaCatalog, "backend">,
  caps: SpeechCapabilities,
  request: QueuedSpeechRequest,
): StartJobOptions {
  const paths = musicPaths(catalog.backend);
  const c = (request.model.constraints ?? {}) as AudioConstraints;
  return {
    kind: "speech",
    model: request.model.id,
    prompt: request.text.trim(),
    extension: c.default_format ?? c.supported_formats?.[0] ?? "mp3",
    queuePath: paths.queue,
    queueBody: speechQueueBody(caps, request),
    retrieve: (queueId) => ({
      path: paths.retrieve,
      body: retrieveBody(queueId, request.model.id),
    }),
    urlFields: ["audio_url", "url"],
  };
}

/** Rough spoken length of a text, for the models billed by the second. Read
 * aloud, a sentence runs at about fifteen characters a second. */
export function estimatedSpeechSeconds(characters: number): number {
  return Math.max(1, Math.ceil(characters / 15));
}

/** Insert an expression tag at the caret, with the spaces it needs. */
export function insertTag(text: string, tag: string, at: number): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${tag}${trail}`;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

// --- provider Voice IDs ----------------------------------------------------

const CUSTOM_VOICES_KEY = "os-june:studio-custom-voice-ids";
const MAX_CUSTOM_VOICES = 8;

/** Voice IDs the person typed before, newest first. A per-device convenience:
 * empty in a private window, never anything that must persist. */
export function rememberedVoiceIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_VOICES_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function rememberVoiceId(id: string): void {
  const trimmed = id.trim();
  if (!trimmed) return;
  const next = [trimmed, ...rememberedVoiceIds().filter((entry) => entry !== trimmed)].slice(
    0,
    MAX_CUSTOM_VOICES,
  );
  try {
    localStorage.setItem(CUSTOM_VOICES_KEY, JSON.stringify(next));
  } catch {
    // Storage refused (private window): the field still works, unremembered.
  }
}
