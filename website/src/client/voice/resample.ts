/**
 * The microphone's rate down to the detector's 16 kHz: the browser's port of
 * `voice/resample.rs`. Linear interpolation that streams across callbacks of
 * any size without clicks at the seams. (An AudioContext at 16 kHz would do
 * it for us in Chrome, but Firefox refuses to connect a microphone to a
 * context at another rate.)
 */
export class Resampler {
  private readonly step: number;
  private position = 0;
  private previous: number | null = null;

  constructor(fromRate: number, toRate: number) {
    this.step = Math.max(1, fromRate) / Math.max(1, toRate);
  }

  process(input: ArrayLike<number>): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    if (Math.abs(this.step - 1) < Number.EPSILON) return Float32Array.from(input);
    const out: number[] = [];
    const sample = (index: number): number => {
      if (index < 0) return this.previous ?? input[0];
      return input[Math.min(index, input.length - 1)] ?? 0;
    };
    let position = this.previous !== null ? this.position - 1 : this.position;
    while (position <= input.length - 1) {
      const base = Math.floor(position);
      const fraction = position - base;
      const a = sample(base);
      const b = sample(base + 1);
      out.push(a + (b - a) * fraction);
      position += this.step;
    }
    this.position = position - (input.length - 1);
    this.previous = input[input.length - 1];
    return Float32Array.from(out);
  }
}
