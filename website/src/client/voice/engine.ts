/**
 * The detector and the state machine joined (`voice/engine.rs`): 16 kHz
 * audio and session inputs in, effects out. Still pure, so the whole loop
 * runs in a test with fakes.
 */
import { type Effect, type Input, Machine } from "./machine";
import { FRAME_SAMPLES, Vad, type VadConfig } from "./vad";

export class Engine {
  private readonly vad: Vad;
  readonly machine: Machine;
  private partial: number[] = [];
  private nextUtterance = 0;
  private utterances = new Map<number, Float32Array>();
  private muted = false;

  constructor(config: VadConfig, fenceLabel: (info: string) => string) {
    this.vad = new Vad(config);
    this.machine = new Machine(fenceLabel);
  }

  /** Microphone audio at 16 kHz, any length; `playbackDb` is what the page
   * is playing now, null when silent. */
  pushAudio(samples: ArrayLike<number>, playbackDb: number | null): Effect[] {
    if (this.muted) return [];
    for (let index = 0; index < samples.length; index++) this.partial.push(samples[index]);
    const effects: Effect[] = [];
    let start = 0;
    while (this.partial.length - start >= FRAME_SAMPLES) {
      const event = this.vad.pushFrame(
        this.partial.slice(start, start + FRAME_SAMPLES),
        playbackDb,
      );
      start += FRAME_SAMPLES;
      if (!event) continue;
      if (event.kind === "speechStarted")
        effects.push(...this.machine.handle({ kind: "speechStarted" }));
      else if (event.kind === "utteranceDiscarded")
        effects.push(...this.machine.handle({ kind: "utteranceDiscarded" }));
      else {
        this.nextUtterance += 1;
        const utterance = this.nextUtterance;
        this.utterances.set(utterance, event.samples);
        effects.push(...this.machine.handle({ kind: "utteranceEnded", utterance }));
      }
    }
    this.partial.splice(0, start);
    return effects;
  }

  handle(input: Input): Effect[] {
    return this.machine.handle(input);
  }

  /** An utterance's audio, handed over once for its transcription. */
  takeUtterance(utterance: number): Float32Array | undefined {
    const samples = this.utterances.get(utterance);
    this.utterances.delete(utterance);
    return samples;
  }

  /** Muting drops a half-heard utterance. */
  setMuted(muted: boolean): Effect[] {
    if (this.muted === muted) return [];
    this.muted = muted;
    if (!muted) return [];
    this.partial = [];
    const wasSpeaking = this.vad.inSpeech();
    this.vad.reset();
    return wasSpeaking ? this.machine.handle({ kind: "utteranceDiscarded" }) : [];
  }
}
