/**
 * When the person starts and stops talking, from the microphone alone: the
 * browser's port of `voice/vad.rs` (ADR-0093). An energy detector with an
 * adaptive floor, hysteresis, a hangover and an echo-aware threshold. Pure:
 * frames in, events out, no clock and no device.
 */
import { VOICE, type VoiceExport } from "./constants";

export const SAMPLE_RATE = VOICE.sampleRate;
/** One analysis frame: 20 ms. */
export const FRAME_SAMPLES = VOICE.frameSamples;
const FRAME_MS = 20;
/** The window the noise floor is the minimum of: 5 s. */
const FLOOR_WINDOW_FRAMES = 250;
/** Before this much history the floor is assumed, not measured. */
const FLOOR_MIN_HISTORY = 10;
const ASSUMED_FLOOR_DB = -60;

export type VadConfig = VoiceExport["vad"];

/** Without echo cancellation: barging in over the reply takes a voice nearly
 * as loud as the reply. */
export function defaultVadConfig(): VadConfig {
  return { ...VOICE.vad };
}

/** Where the platform cancels the reply's echo. */
export function echoCancelledVadConfig(): VadConfig {
  return { ...VOICE.vad, echoCouplingDb: VOICE.echoCancelledCouplingDb };
}

export type VadEvent =
  | { kind: "speechStarted" }
  | { kind: "utteranceEnded"; samples: Float32Array }
  | { kind: "utteranceDiscarded" };

/** Root mean square of a frame, in dBFS (silence reads as -100). */
export function frameDb(frame: ArrayLike<number>): number {
  if (frame.length === 0) return -100;
  let sum = 0;
  for (let index = 0; index < frame.length; index++) sum += frame[index] * frame[index];
  const power = sum / frame.length;
  return power <= 1e-10 ? -100 : 10 * Math.log10(power);
}

interface Speech {
  samples: number[];
  voicedFrames: number;
  silentRun: number;
  frames: number;
}

export class Vad {
  private levels: number[] = [];
  private onsetRun = 0;
  private preRoll: number[] = [];
  private speech: Speech | null = null;

  constructor(private readonly config: VadConfig = defaultVadConfig()) {}

  inSpeech(): boolean {
    return this.speech !== null;
  }

  /** The level speech must reach now; `playbackDb` is the reply's level, or
   * null while the page is silent. */
  thresholdDb(playbackDb: number | null): number {
    const base = Math.max(this.floorDb() + this.config.aboveFloorDb, this.config.minSpeechDb);
    return playbackDb === null
      ? base
      : Math.max(base, playbackDb + this.config.echoCouplingDb + this.config.echoMarginDb);
  }

  /** Forgets a half-heard utterance. */
  reset() {
    this.onsetRun = 0;
    this.speech = null;
    this.preRoll = [];
  }

  pushFrame(frame: ArrayLike<number>, playbackDb: number | null): VadEvent | null {
    const level = frameDb(frame);
    const threshold = this.thresholdDb(playbackDb);
    // The floor learns from every frame but the page's own voice.
    if (playbackDb === null) {
      this.levels.push(level);
      if (this.levels.length > FLOOR_WINDOW_FRAMES) this.levels.shift();
    }
    const speech = this.speech;
    if (!speech) {
      if (level >= threshold) this.onsetRun += 1;
      else this.onsetRun = Math.max(0, this.onsetRun - 2);
      for (let index = 0; index < frame.length; index++) this.preRoll.push(frame[index]);
      const keep = Math.floor((this.config.preRollMs * SAMPLE_RATE) / 1000);
      if (this.preRoll.length > keep) this.preRoll.splice(0, this.preRoll.length - keep);
      const onsetMs = playbackDb !== null ? this.config.bargeInOnsetMs : this.config.onsetMs;
      if (this.onsetRun * FRAME_MS >= onsetMs) {
        this.onsetRun = 0;
        const samples = this.preRoll;
        this.preRoll = [];
        this.speech = {
          samples,
          voicedFrames: Math.floor(onsetMs / FRAME_MS),
          silentRun: 0,
          frames: Math.floor(samples.length / Math.max(1, FRAME_SAMPLES)),
        };
        return { kind: "speechStarted" };
      }
      return null;
    }
    for (let index = 0; index < frame.length; index++) speech.samples.push(frame[index]);
    speech.frames += 1;
    if (level >= threshold - this.config.hysteresisDb) {
      speech.voicedFrames += 1;
      speech.silentRun = 0;
    } else {
      speech.silentRun += 1;
    }
    const ended = speech.silentRun * FRAME_MS >= this.config.endSilenceMs;
    const tooLong = speech.frames * FRAME_MS >= this.config.maxUtteranceMs;
    if (!ended && !tooLong) return null;
    this.speech = null;
    if (speech.voicedFrames * FRAME_MS < this.config.minVoicedMs)
      return { kind: "utteranceDiscarded" };
    let samples = speech.samples;
    if (ended) {
      // Keep a short tail of the silence: transcription pays by the second.
      const tail = Math.max(0, speech.silentRun - 10) * FRAME_SAMPLES;
      samples = samples.slice(0, Math.max(0, samples.length - tail));
    }
    return { kind: "utteranceEnded", samples: Float32Array.from(samples) };
  }

  /** The room's noise: the quietest recent frame. */
  private floorDb(): number {
    if (this.levels.length < FLOOR_MIN_HISTORY) return ASSUMED_FLOOR_DB;
    return Math.max(Math.min(...this.levels), -90);
  }
}
