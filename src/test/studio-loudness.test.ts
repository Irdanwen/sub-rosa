import { describe, expect, it } from "vitest";
import {
  applyGain,
  DEFAULT_TARGET_LUFS,
  headShelf,
  integratedLufs,
  normalizationGain,
  rlbHighPass,
} from "../lib/studio/loudness";

/** A sine at `amplitude`, `seconds` long, on every channel. */
function sine(amplitude: number, seconds: number, sampleRate = 48000, channels = 2, hz = 1000) {
  const length = Math.round(seconds * sampleRate);
  return {
    sampleRate,
    channels: Array.from({ length: channels }, () => {
      const data = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        data[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / sampleRate);
      }
      return data;
    }),
  };
}

describe("K-weighting", () => {
  it("reproduces the standard's own 48 kHz coefficients", () => {
    // The coefficients are derived for the actual sample rate rather than
    // copied, so that a 44.1 kHz mix is not measured with 48 kHz filters. This
    // is the check that the derivation is the standard's and not merely close.
    const shelf = headShelf(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 10);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 10);

    const highPass = rlbHighPass(48000);
    expect(highPass.b0).toBeCloseTo(1, 10);
    expect(highPass.b1).toBeCloseTo(-2, 10);
    expect(highPass.b2).toBeCloseTo(1, 10);
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 8);
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 8);
  });

  it("derives different coefficients for a different rate", () => {
    expect(headShelf(44100).b0).not.toBeCloseTo(headShelf(48000).b0, 4);
  });
});

describe("integrated loudness", () => {
  it("reads the standard's reference signal at its stated value", () => {
    // BS.1770: a 1 kHz sine at -20 dBFS on left and right reads -20 LUFS. The
    // -0.691 offset exists precisely to make this true, so it is the one
    // measurement that validates the whole chain at once.
    expect(integratedLufs(sine(0.1, 3))).toBeCloseTo(-20, 1);
  });

  it("moves exactly 6 dB when the signal doubles", () => {
    const quiet = integratedLufs(sine(0.1, 3));
    const loud = integratedLufs(sine(0.2, 3));
    expect(loud - quiet).toBeCloseTo(6.02, 1);
  });

  it("reads mono 3 dB under the same sine in stereo", () => {
    // Loudness sums weighted channel power, so one channel is half the power.
    const stereo = integratedLufs(sine(0.1, 3));
    const mono = integratedLufs(sine(0.1, 3, 48000, 1));
    expect(stereo - mono).toBeCloseTo(3.01, 1);
  });

  it("measures the same signal the same at another sample rate", () => {
    expect(integratedLufs(sine(0.1, 3, 44100))).toBeCloseTo(integratedLufs(sine(0.1, 3, 48000)), 1);
  });

  it("does not let silence drag a programme down", () => {
    // Half signal, half digital silence. Without the gates this would read
    // about 3 dB quiet, and normalising on it would make the loud half hurt.
    const signal = sine(0.1, 3);
    const withSilence = {
      sampleRate: 48000,
      channels: signal.channels.map((channel) => {
        const padded = new Float32Array(channel.length * 2);
        padded.set(channel, 0);
        return padded;
      }),
    };
    // Ungated it would read about 3 dB quiet. What is left is the block that
    // straddles the boundary, which the standard keeps and which is worth a
    // couple of tenths - not the several decibels the gates exist to remove.
    const ungatedPenaltyDb = 3;
    const delta = Math.abs(integratedLufs(withSilence) - integratedLufs(signal));
    expect(delta).toBeLessThan(0.5);
    expect(delta).toBeLessThan(ungatedPenaltyDb / 4);
  });

  it("has no reading for silence or for nothing at all", () => {
    expect(integratedLufs(sine(0, 3))).toBe(Number.NEGATIVE_INFINITY);
    expect(integratedLufs({ sampleRate: 48000, channels: [] })).toBe(Number.NEGATIVE_INFINITY);
    // Shorter than one 400 ms block: there is nothing to measure.
    expect(integratedLufs(sine(0.1, 0.2))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("normalisation", () => {
  it("brings a measured programme to the target", () => {
    const measured = integratedLufs(sine(0.1, 3));
    const gain = normalizationGain(measured, DEFAULT_TARGET_LUFS);
    const signal = sine(0.1, 3);
    applyGain(signal.channels, gain);
    expect(integratedLufs(signal)).toBeCloseTo(DEFAULT_TARGET_LUFS, 1);
  });

  it("leaves near-silence alone instead of amplifying its noise", () => {
    expect(normalizationGain(-80, -14)).toBe(1);
    expect(normalizationGain(Number.NEGATIVE_INFINITY, -14)).toBe(1);
  });

  it("clamps rather than clipping past full scale", () => {
    const channel = new Float32Array([0.9, -0.9, 0.1]);
    applyGain([channel], 4);
    expect(channel[0]).toBe(1);
    expect(channel[1]).toBe(-1);
    expect(channel[2]).toBeCloseTo(0.4, 6);
  });
});
