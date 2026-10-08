/**
 * The page's microphone and speaker for a voice conversation.
 *
 * The microphone is asked with the browser's echo cancellation, noise
 * suppression and gain control on. Whether a browser cancels the echo of
 * audio a page plays through Web Audio varies, so the detector keeps the
 * app's echo-aware threshold for speakers that are heard (the plain
 * configuration) and the screen suggests headphones, as on a computer
 * without the voice-processing unit (ADR-0093 decision 6).
 *
 * Audio is read with a ScriptProcessorNode rather than an AudioWorklet: a
 * worklet is a script URL the site's Trusted Types policy would have to
 * admit, and twenty-millisecond frames do not need the audio thread.
 */
import { VOICE } from "./constants";
import { Resampler } from "./resample";
import type { VoicePlayer } from "./session";
import { frameDb, SAMPLE_RATE } from "./vad";

export interface Microphone {
  context: AudioContext;
  stop(): void;
}

export async function openMicrophone(
  onSamples: (samples: Float32Array) => void,
): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(2048, 1, 1);
  const resampler = new Resampler(context.sampleRate, SAMPLE_RATE);
  processor.onaudioprocess = (event) => {
    onSamples(resampler.process(event.inputBuffer.getChannelData(0)));
  };
  // A processor runs only while connected onwards; its output stays silent.
  source.connect(processor);
  processor.connect(context.destination);
  return {
    context,
    stop() {
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close().catch(() => undefined);
    },
  };
}

/** Plays rendered sentences through Web Audio (no media URL, so the CSP
 * stays as narrow as it is) and reports its level for the detector, held
 * for the echo tail after it goes quiet, as the app's player does. */
export class WebAudioPlayer implements VoicePlayer {
  private source: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode;
  private finish: (() => void) | null = null;
  private held = -100;
  private heldUntil = 0;
  private readonly buffer: Float32Array<ArrayBuffer>;

  constructor(
    private readonly context: AudioContext,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.connect(context.destination);
    this.buffer = new Float32Array(this.analyser.fftSize);
  }

  async play(clip: ArrayBuffer): Promise<void> {
    this.stop();
    const decoded = await this.context.decodeAudioData(clip.slice(0));
    await new Promise<void>((resolve) => {
      const source = this.context.createBufferSource();
      source.buffer = decoded;
      source.connect(this.analyser);
      this.source = source;
      this.finish = resolve;
      source.onended = () => {
        if (this.source === source) {
          this.source = null;
          this.heldUntil = this.now() + VOICE.echoTailMs;
        }
        resolve();
      };
      source.start();
    });
  }

  stop() {
    const source = this.source;
    this.source = null;
    if (source) {
      this.heldUntil = this.now() + VOICE.echoTailMs;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.finish?.();
    this.finish = null;
  }

  levelDb(): number | null {
    if (this.source) {
      this.analyser.getFloatTimeDomainData(this.buffer);
      // Peak-hold with a slow release, so a pause between two words does not
      // drop the threshold under the next syllable.
      this.held = Math.max(frameDb(this.buffer), this.held - 0.5);
      return this.held;
    }
    if (this.now() < this.heldUntil) return this.held;
    this.held = -100;
    return null;
  }
}
