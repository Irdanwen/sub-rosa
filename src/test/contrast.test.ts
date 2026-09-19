import { describe, expect, it } from "vitest";
// Read through Vite like the other CSS contract tests, not node:fs.
import primitives from "../../packages/design/primitives.css?raw";
import { BRAND_PRESETS } from "../lib/brand";

/**
 * The charter's contrast gate (docs/design/charte.md).
 *
 * The system these values are derived from has no test like this one, and it
 * shows: its own accent measures 2.32:1 on its own light ground, so links, doc
 * headings and the primary button label are all unreadable there. The audit
 * that measured it was written, then abandoned. A charter with no gate rots.
 *
 * So: every colour pair that carries text is named here with the ratio it must
 * hold. Change a value in primitives.css and this turns red with the number.
 */

/** Reads a literal token out of primitives.css, following one level of alias. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(primitives);
  if (!match) throw new Error(`primitives.css has no --${name}`);
  const value = match[1].trim();
  const alias = /^var\(--(sr-[a-z0-9-]+)\)$/.exec(value);
  return alias ? token(alias[1]) : value;
}

// --- colour maths -------------------------------------------------------
// WCAG 2.1 relative luminance, and the oklch interpolation browsers perform
// for color-mix(). Both are reimplemented here rather than imported: a gate
// that shares an implementation with the thing it guards tests nothing.

function channels(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) throw new Error(`Not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => Number.parseInt(raw.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklch(hex: string) {
  const [r, g, b] = channels(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(B, A) * 180) / Math.PI;
  return { L, C: Math.hypot(A, B), H: hue < 0 ? hue + 360 : hue };
}

function fromOklch(L: number, C: number, H: number): string {
  const rad = (H * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) =>
    Math.round(Math.min(1, Math.max(0, fromLinear(c))) * 255)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${rgb.join("")}`;
}

/**
 * color-mix(in oklch, `a` `percent`%, `b`). An achromatic colour's hue is
 * powerless (CSS Color 4), so black and white carry the other colour's hue
 * instead of dragging it toward 0 — which is what makes the --brand-ink recipe
 * stay in the accent's family rather than turning red.
 */
function mixOklch(a: string, percent: number, b: string): string {
  const x = toOklch(a);
  const y = toOklch(b);
  const weight = percent / 100;
  const hueA = x.C < 0.0001 ? y.H : x.H;
  const hueB = y.C < 0.0001 ? x.H : y.H;
  let delta = hueB - hueA;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return fromOklch(
    x.L * weight + y.L * (1 - weight),
    x.C * weight + y.C * (1 - weight),
    hueA + delta * (1 - weight),
  );
}

const CREAM = token("sr-cream");
const CREAM_RAISED = token("sr-cream-raised");
const INK = token("sr-ink");
const INK_RAISED = token("sr-ink-raised");

/**
 * 4.5:1 is the AA floor for body text. The two "dim" tones sit at 4:1: they
 * are a tertiary tone used at UI sizes for counts and timestamps, never for
 * anything a person has to read to use the app. Below 4:1 they stop being
 * quiet and start being absent — which is where the source system left them.
 */
const BODY = 4.5;
const TERTIARY = 4;

describe("charter contrast", () => {
  describe("text on the light ground", () => {
    const pairs: Array<[string, string, number]> = [
      ["sr-on-cream", CREAM, BODY],
      ["sr-on-cream-muted", CREAM, BODY],
      ["sr-on-cream-dim", CREAM, TERTIARY],
      ["sr-gold-ink", CREAM, BODY],
      ["sr-gold-ink-hover", CREAM, BODY],
      ["sr-imperial", CREAM, BODY],
      ["sr-success", CREAM, BODY],
      ["sr-warning", CREAM, BODY],
      ["sr-info", CREAM, BODY],
      // A card sits on the raised cream, so the quiet tones are checked there too.
      ["sr-on-cream-dim", CREAM_RAISED, TERTIARY],
      ["sr-gold-ink", CREAM_RAISED, BODY],
    ];
    for (const [name, ground, floor] of pairs) {
      it(`${name} clears ${floor}:1`, () => {
        expect(contrast(token(name), ground)).toBeGreaterThanOrEqual(floor);
      });
    }
  });

  describe("text on the dark ground", () => {
    const pairs: Array<[string, string, number]> = [
      ["sr-on-ink", INK, BODY],
      ["sr-on-ink-muted", INK, BODY],
      ["sr-on-ink-dim", INK, TERTIARY],
      ["sr-gold-ink-dark", INK, BODY],
      ["sr-gold-ink-dark-hover", INK, BODY],
      ["sr-imperial-on-ink", INK, BODY],
      ["sr-success-on-ink", INK, BODY],
      ["sr-warning-on-ink", INK, BODY],
      ["sr-info-on-ink", INK, BODY],
      ["sr-on-ink-dim", INK_RAISED, TERTIARY],
      ["sr-gold-ink-dark", INK_RAISED, BODY],
      ["sr-imperial-on-ink", INK_RAISED, BODY],
    ];
    for (const [name, ground, floor] of pairs) {
      it(`${name} clears ${floor}:1`, () => {
        expect(contrast(token(name), ground)).toBeGreaterThanOrEqual(floor);
      });
    }
  });

  it("the primary button's label is readable on its own fill", () => {
    expect(contrast(CREAM, token("sr-gold-ink"))).toBeGreaterThanOrEqual(BODY);
    expect(contrast(INK, token("sr-gold-ink-dark"))).toBeGreaterThanOrEqual(BODY);
  });

  it("display gold is never asked to carry text on the light ground", () => {
    // Not a defect: this is the whole reason the charter splits the gold. The
    // assertion is here so that anyone tempted to collapse the two tokens back
    // into one sees the number that made them separate.
    expect(contrast(token("sr-gold-display"), CREAM)).toBeLessThan(BODY);
    expect(contrast(token("sr-gold-ink"), CREAM)).toBeGreaterThanOrEqual(BODY);
  });

  /**
   * The accent is a runtime setting, so the gate has to cover the recipe, not
   * one value: --brand-ink is color-mix(in oklch, --brand <n>%, black|white),
   * and every preset has to land readable in both themes. Without this, adding
   * a preset is a coin flip.
   */
  describe("every accent preset stays readable through the --brand-ink recipe", () => {
    const light = Number.parseFloat(token("sr-ink-mix-light"));
    const dark = Number.parseFloat(token("sr-ink-mix-dark"));

    for (const preset of BRAND_PRESETS) {
      it(`${preset.id} holds ${BODY}:1 in both themes`, () => {
        const lightGround = mixOklch(preset.value, 3, CREAM);
        const darkGround = mixOklch(preset.value, 6, INK);
        const lightInk = mixOklch(preset.value, light, "#000000");
        const darkInk = mixOklch(preset.value, dark, "#ffffff");

        expect(contrast(lightInk, lightGround)).toBeGreaterThanOrEqual(BODY);
        expect(contrast(darkInk, darkGround)).toBeGreaterThanOrEqual(BODY);
        // The same tones are also used as button fills, with the ground as the
        // label colour, so the pair has to hold in both directions.
        expect(contrast(lightGround, lightInk)).toBeGreaterThanOrEqual(BODY);
        expect(contrast(darkGround, darkInk)).toBeGreaterThanOrEqual(BODY);
      });
    }
  });
});
