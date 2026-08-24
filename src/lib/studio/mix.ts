/**
 * The mix: every sound in a film, placed, levelled and rendered once.
 *
 * What was here before was one background track at a fixed gain under whatever
 * the clips happened to carry, summed live while a MediaRecorder captured the
 * canvas. That is a monitor path, not a mix: the levels drift with the machine's
 * load, the result is different every time, and there is nowhere to put a line
 * of dialogue.
 *
 * So the mix is rendered *offline*, faster than real time, into one buffer that
 * the recording then simply plays. Three things follow from that, and they are
 * the reason this is worth its size:
 *
 *  - **It is deterministic.** The same cut mixes to the same samples, so a
 *    level the user set is the level they get, every time.
 *  - **It can be measured.** Programme loudness needs the whole programme
 *    (`./loudness`), which is impossible while it is being played.
 *  - **Ducking is automation, not a compressor.** The dialogue windows are
 *    known before anything sounds, so the music is written down under them at
 *    exactly the right instants instead of being squashed by a detector that
 *    hears the music too.
 *
 * The planning is pure and lives here in full; `renderMix` is a thin walk over
 * that plan into an `OfflineAudioContext`. That split is deliberate: an audio
 * graph cannot be tested outside a browser, and all the decisions are in the
 * plan.
 */

import { applyGain, DEFAULT_TARGET_LUFS, integratedLufs, normalizationGain } from "./loudness";

/** The four things a film's sound comes from. */
export const MIX_LANES = ["clips", "dialogue", "sfx", "music"] as const;
export type MixLane = (typeof MIX_LANES)[number];

/**
 * A short fade at every clip boundary.
 *
 * Thirty milliseconds is inaudible as a fade and is the difference between a
 * clean cut and a click: a butt splice between two waveforms at different
 * instantaneous values is a step, and a step is a broadband pop.
 */
export const EDGE_FADE_SECONDS = 0.03;

/** How far ahead of a line the music starts getting out of the way. */
export const DUCK_ATTACK_SECONDS = 0.15;
/** How long it takes to come back after the line ends. */
export const DUCK_RELEASE_SECONDS = 0.4;
/** How far down it goes. Six decibels is audible and not a hole. */
export const DUCK_GAIN = 0.5;

/** The gap left between two lines that would otherwise collide. */
export const DIALOGUE_GAP_SECONDS = 0.25;

/** A sound to place. `id` names the decoded buffer the renderer will use. */
export interface MixSource {
  id: string;
  lane: MixLane;
  /** Where it starts on the timeline. */
  atSeconds: number;
  /** Where it starts inside its own file. */
  inSeconds: number;
  /** Where it stops inside its own file. */
  outSeconds: number;
  /** Static level, 1 being unity. */
  gain?: number;
}

/** One point in a lane's level automation. */
export interface GainStop {
  atSeconds: number;
  gain: number;
}

export interface MixPlan {
  durationSeconds: number;
  sources: MixSource[];
  /** Per-lane automation. A lane with no stops plays at unity. */
  automation: Partial<Record<MixLane, GainStop[]>>;
}

export interface Window {
  start: number;
  end: number;
}

/**
 * Overlapping or touching windows merged into the fewest that cover the same
 * time. Ducking needs this: two lines half a second apart must be one dip, not
 * two, or the music pumps between them.
 */
export function mergeWindows(windows: readonly Window[], joinWithinSeconds = 0): Window[] {
  const sorted = [...windows]
    .filter((window) => window.end > window.start)
    .sort((left, right) => left.start - right.start);
  const merged: Window[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start - last.end <= joinWithinSeconds) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

export interface DuckOptions {
  attackSeconds?: number;
  releaseSeconds?: number;
  duckGain?: number;
  durationSeconds: number;
}

/**
 * The music lane's level, written as a list of points.
 *
 * Deterministic on purpose. A sidechain compressor listening to the dialogue
 * bus also hears the music leaking through the mix and ducks against itself;
 * and its timing depends on a detector's attack rather than on where the line
 * actually is. Here the windows are known in advance, so the dip starts before
 * the first syllable and lifts after the last.
 */
export function duckStops(windows: readonly Window[], options: DuckOptions): GainStop[] {
  const attack = options.attackSeconds ?? DUCK_ATTACK_SECONDS;
  const release = options.releaseSeconds ?? DUCK_RELEASE_SECONDS;
  const gain = options.duckGain ?? DUCK_GAIN;
  // Windows closer together than one release plus one attack are one dip.
  const merged = mergeWindows(windows, attack + release);
  if (merged.length === 0) return [];

  const stops: GainStop[] = [{ atSeconds: 0, gain: 1 }];
  for (const window of merged) {
    const down = Math.max(0, window.start - attack);
    const up = Math.min(options.durationSeconds, window.end + release);
    // A dip that would begin before the previous one lifted is already covered
    // by the merge above, so the points are always in order.
    if (down > (stops[stops.length - 1]?.atSeconds ?? 0)) {
      stops.push({ atSeconds: down, gain: 1 });
    }
    stops.push({ atSeconds: window.start, gain });
    stops.push({ atSeconds: window.end, gain });
    if (up > window.end) stops.push({ atSeconds: up, gain: 1 });
  }
  return stops;
}

export interface SchedulableLine {
  /** Measured, never announced: a TTS file is as long as it is. */
  durationSeconds: number;
  /** Where the line would like to be, if it fits. */
  preferredAtSeconds?: number;
}

/**
 * Where each line actually goes, so that no two ever overlap.
 *
 * One cursor for the whole film rather than one per scene: two lines that
 * belong to different shots still collide if the first one runs long, and a
 * generated voice runs as long as it runs. A line whose preferred position has
 * already passed is pushed to the cursor rather than dropped - late is
 * recoverable, missing is not.
 */
export function scheduleWithoutOverlap(
  lines: readonly SchedulableLine[],
  gapSeconds = DIALOGUE_GAP_SECONDS,
): number[] {
  let cursor = 0;
  return lines.map((line) => {
    const at = Math.max(cursor, line.preferredAtSeconds ?? 0);
    cursor = at + Math.max(0, line.durationSeconds) + gapSeconds;
    return at;
  });
}

export interface MixInput {
  durationSeconds: number;
  sources: MixSource[];
  /** Duck the music under the dialogue. On by default: it is what a mix is. */
  duck?: boolean;
  duckGain?: number;
}

/** Everything the renderer needs, decided. */
export function planMix(input: MixInput): MixPlan {
  const sources = input.sources.filter((source) => source.outSeconds > source.inSeconds);
  const automation: Partial<Record<MixLane, GainStop[]>> = {};

  const hasMusic = sources.some((source) => source.lane === "music");
  if ((input.duck ?? true) && hasMusic) {
    const windows = sources
      .filter((source) => source.lane === "dialogue")
      .map((source) => ({
        start: source.atSeconds,
        end: source.atSeconds + (source.outSeconds - source.inSeconds),
      }));
    const stops = duckStops(windows, {
      durationSeconds: input.durationSeconds,
      duckGain: input.duckGain,
    });
    if (stops.length > 0) automation.music = stops;
  }

  return { durationSeconds: input.durationSeconds, sources, automation };
}

export interface RenderMixOptions {
  /** Decoded audio, keyed by `MixSource.id`. A missing id is skipped. */
  buffers: ReadonlyMap<string, AudioBuffer>;
  sampleRate?: number;
  /** Programme loudness to normalise to. `null` leaves levels alone. */
  targetLufs?: number | null;
}

export interface RenderedMix {
  buffer: AudioBuffer;
  /** Measured before normalisation. `-Infinity` when there was no sound. */
  measuredLufs: number;
  /** The single gain applied to reach the target. */
  appliedGain: number;
}

/**
 * Render the plan into one buffer.
 *
 * A thin walk over the plan: one buffer source per sound, one gain node per
 * sound for its level and its edge fades, one gain node per lane for the
 * automation. Everything interesting was decided in `planMix`.
 */
export async function renderMix(
  plan: MixPlan,
  options: RenderMixOptions,
): Promise<RenderedMix | undefined> {
  if (typeof OfflineAudioContext === "undefined") return undefined;
  const sampleRate = options.sampleRate ?? 48000;
  const frames = Math.max(1, Math.ceil(plan.durationSeconds * sampleRate));
  const context = new OfflineAudioContext(2, frames, sampleRate);

  const laneGain = new Map<MixLane, GainNode>();
  for (const lane of MIX_LANES) {
    const gain = context.createGain();
    const stops = plan.automation[lane];
    if (stops && stops.length > 0) {
      gain.gain.setValueAtTime(stops[0].gain, 0);
      for (const stop of stops) {
        gain.gain.linearRampToValueAtTime(stop.gain, Math.max(0, stop.atSeconds));
      }
    }
    gain.connect(context.destination);
    laneGain.set(lane, gain);
  }

  let placed = 0;
  for (const source of plan.sources) {
    const buffer = options.buffers.get(source.id);
    if (!buffer) continue;
    const length = Math.min(source.outSeconds, buffer.duration) - source.inSeconds;
    if (length <= 0) continue;

    const node = context.createBufferSource();
    node.buffer = buffer;
    const gain = context.createGain();
    const level = source.gain ?? 1;
    // Edge fades, shortened for a sound too brief to carry a full one.
    const fade = Math.min(EDGE_FADE_SECONDS, length / 2);
    const start = Math.max(0, source.atSeconds);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + fade);
    gain.gain.setValueAtTime(level, start + length - fade);
    gain.gain.linearRampToValueAtTime(0, start + length);
    node.connect(gain).connect(laneGain.get(source.lane) ?? context.destination);
    node.start(start, source.inSeconds, length);
    placed += 1;
  }
  if (placed === 0) return undefined;

  const rendered = await context.startRendering();
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, index) =>
    rendered.getChannelData(index),
  );
  const measuredLufs = integratedLufs({ sampleRate: rendered.sampleRate, channels });
  const target = options.targetLufs === undefined ? DEFAULT_TARGET_LUFS : options.targetLufs;
  const appliedGain = target === null ? 1 : normalizationGain(measuredLufs, target);
  applyGain(channels, appliedGain);

  return { buffer: rendered, measuredLufs, appliedGain };
}
