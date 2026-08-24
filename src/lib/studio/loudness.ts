/**
 * Programme loudness, to ITU-R BS.1770 / EBU R 128.
 *
 * A film whose mix is quieter than everything else the viewer watched today is
 * a film they turn up, and then the next thing blows their ears out. Every
 * broadcaster and every streaming service normalises for that reason, and it is
 * one number: integrated loudness, in LUFS.
 *
 * Written as plain arithmetic over sample arrays rather than as a Web Audio
 * graph, on purpose. The K-weighting filters are two biquads and the gating is
 * two passes over their output - about thirty lines - and having it as pure
 * maths means it can be tested against the standard's own reference signal
 * instead of only in a browser. `./mix` is the part that needs an audio graph.
 *
 * The filter coefficients are derived for the actual sample rate rather than
 * copied from the standard's 48 kHz table: a 44.1 kHz mix measured with 48 kHz
 * coefficients reads about a decibel off, which is exactly the size of error
 * nobody notices and everybody inherits.
 */

/** What broadcast and the streaming services converged on. */
export const DEFAULT_TARGET_LUFS = -14;

/** A signal to measure: deinterleaved channels plus their rate. */
export interface LoudnessInput {
  sampleRate: number;
  /** One array per channel. Stereo is the normal case. */
  channels: readonly Float32Array[];
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Stage 1 of the K-weighting: the high shelf that stands in for the head.
 *
 * The magic constants are the standard's analog prototype; the bilinear
 * transform below reproduces its published 48 kHz table exactly, which is what
 * the test checks.
 */
export function headShelf(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = 10 ** (gainDb / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** Stage 2: the high pass that discards what loudness does not hear. */
export function rlbHighPass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + k / q + k * k;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** Direct form I, in place on a copy. */
function filtered(samples: Float32Array, filter: Biquad): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const x0 = samples[index];
    const y0 = filter.b0 * x0 + filter.b1 * x1 + filter.b2 * x2 - filter.a1 * y1 - filter.a2 * y2;
    out[index] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/**
 * Channel weights. Stereo and mono weigh 1; the surround channels weigh more
 * because the standard says the ear does. Anything beyond 5.1 weighs 1, which
 * is a guess we will never exercise.
 */
function channelWeight(index: number, count: number): number {
  if (count >= 5 && (index === 3 || index === 4)) return 1.41;
  return 1;
}

const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1;
/** The standard's offset: it makes a 1 kHz sine at -20 dBFS read -20 LUFS. */
const OFFSET_DB = -0.691;
/** Below this a block is silence, and silence must not drag the average down. */
const ABSOLUTE_GATE_LUFS = -70;
/** The second gate sits this far under the ungated average. */
const RELATIVE_GATE_LU = 10;

function blockLoudness(power: number): number {
  return power > 0 ? OFFSET_DB + 10 * Math.log10(power) : Number.NEGATIVE_INFINITY;
}

/**
 * Integrated loudness in LUFS, or `-Infinity` for something with no signal.
 *
 * Two gates, as the standard requires: an absolute one that drops silence, and
 * a relative one that drops whatever sits far under the programme's own
 * average. Without them a film with long quiet passages measures far quieter
 * than it sounds, and normalising on that figure makes the loud parts painful.
 */
export function integratedLufs(input: LoudnessInput): number {
  const { sampleRate, channels } = input;
  if (channels.length === 0 || sampleRate <= 0) return Number.NEGATIVE_INFINITY;
  const length = channels[0]?.length ?? 0;
  const blockSamples = Math.round(BLOCK_SECONDS * sampleRate);
  const stepSamples = Math.round(STEP_SECONDS * sampleRate);
  if (length < blockSamples || blockSamples <= 0) return Number.NEGATIVE_INFINITY;

  const weighted = channels.map((channel) =>
    filtered(filtered(channel, headShelf(sampleRate)), rlbHighPass(sampleRate)),
  );

  // Mean square per block, summed across weighted channels.
  const powers: number[] = [];
  for (let start = 0; start + blockSamples <= length; start += stepSamples) {
    let power = 0;
    for (const [index, channel] of weighted.entries()) {
      let sum = 0;
      for (let offset = start; offset < start + blockSamples; offset += 1) {
        sum += channel[offset] * channel[offset];
      }
      power += channelWeight(index, weighted.length) * (sum / blockSamples);
    }
    powers.push(power);
  }
  if (powers.length === 0) return Number.NEGATIVE_INFINITY;

  const aboveAbsolute = powers.filter((power) => blockLoudness(power) > ABSOLUTE_GATE_LUFS);
  if (aboveAbsolute.length === 0) return Number.NEGATIVE_INFINITY;

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const relativeGate = blockLoudness(mean(aboveAbsolute)) - RELATIVE_GATE_LU;
  const kept = aboveAbsolute.filter((power) => blockLoudness(power) > relativeGate);
  if (kept.length === 0) return Number.NEGATIVE_INFINITY;

  return blockLoudness(mean(kept));
}

/**
 * The single gain that brings a measured programme to the target.
 *
 * Capped, because normalising near-silence is not a normalisation but an
 * amplification of whatever noise is in there. A programme more than 30 dB
 * under the target is left alone rather than blown up.
 */
export function normalizationGain(
  measuredLufs: number,
  targetLufs: number = DEFAULT_TARGET_LUFS,
): number {
  if (!Number.isFinite(measuredLufs)) return 1;
  const deltaDb = targetLufs - measuredLufs;
  if (deltaDb > 30) return 1;
  return 10 ** (deltaDb / 20);
}

/** Scales every sample in place, clamping so normalisation cannot clip. */
export function applyGain(channels: readonly Float32Array[], gain: number): void {
  if (gain === 1) return;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = Math.max(-1, Math.min(1, channel[index] * gain));
    }
  }
}
