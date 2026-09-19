import { describe, expect, it } from "vitest";
import meetingHudRs from "../../src-tauri/src/meeting_hud.rs?raw";
import primitives from "../../packages/design/primitives.css?raw";
import tokens from "../styles/tokens.css?raw";
import { EASE_IN_OUT, EASE_OUT, EASE_OUT_CSS, EASE_SPRING, EASE_SPRING_CSS } from "../lib/motion";

/**
 * src/lib/motion.ts says "keep the values in lockstep with tokens.css" and,
 * until this test, nothing made that true. framer-motion takes numbers and CSS
 * takes a cubic-bezier string, so the two drift silently: the same transition
 * runs one curve in a CSS rule and a different one in a JS-driven view, and it
 * only ever shows up as "the panel feels flatter than the sheet".
 */

function curve(css: string, name: string): [number, number, number, number] {
  const match = new RegExp(`--${name}:\\s*cubic-bezier\\(([^)]+)\\)`).exec(css);
  if (!match) throw new Error(`No cubic-bezier for --${name}`);
  const parts = match[1].split(",").map((n) => Number.parseFloat(n.trim()));
  expect(parts).toHaveLength(4);
  return parts as [number, number, number, number];
}

/** Follows tokens.css's `--ease-out: var(--sr-ease-out)` back to the literal. */
function appCurve(name: string): [number, number, number, number] {
  const alias = new RegExp(`--${name}:\\s*var\\(--(sr-[a-z-]+)\\)`).exec(tokens);
  if (!alias) throw new Error(`--${name} in tokens.css is not an alias of a primitive`);
  return curve(primitives, alias[1]);
}

describe("motion tokens", () => {
  it("tokens.css takes its curves from the shared primitives", () => {
    // Asserting the alias, not the numbers: a literal copied into tokens.css
    // is exactly the drift this guards against.
    expect(tokens).toContain("--ease-out: var(--sr-ease-out);");
    expect(tokens).toContain("--ease-in-out: var(--sr-ease-in-out);");
    expect(tokens).toContain("--ease-spring: var(--sr-ease-drawer);");
  });

  it("the JS mirror matches the CSS curves", () => {
    expect(EASE_OUT).toEqual(appCurve("ease-out"));
    expect(EASE_IN_OUT).toEqual(appCurve("ease-in-out"));
    expect(EASE_SPRING).toEqual(appCurve("ease-spring"));
  });

  it("the CSS string forms match their own number forms", () => {
    expect(EASE_OUT_CSS).toBe(`cubic-bezier(${EASE_OUT.join(", ")})`);
    expect(EASE_SPRING_CSS).toBe(`cubic-bezier(${EASE_SPRING.join(", ")})`);
  });

  it("the entrance and exit curves do not start slow", () => {
    // An ease-in delays the exact instant the user is watching, so nothing
    // that enters or leaves may use one. The signature is a first control
    // point whose x leads its y.
    //
    // --ease-in-out is exempt and must be: a slow start is its "in" half, and
    // it is the right curve for something already on screen that moves.
    for (const [name, [x1, y1]] of [
      ["ease-out", EASE_OUT],
      ["ease-spring", EASE_SPRING],
    ] as const) {
      expect(y1, `${name} starts slow`).toBeGreaterThanOrEqual(x1);
    }
  });

  it("the native meeting HUD turns on the same curve", () => {
    // A fourth copy of --ease-out, and the only one outside CSS: the HUD's
    // window frame is turned by Core Animation while its contents move by CSS,
    // so a drift between the two shears the pill mid-turn. Core Animation
    // takes the four control points as bare floats, which is why it cannot
    // just read the token.
    // Rust wants a decimal point on a whole number; CSS does not.
    const rust = EASE_OUT.map((n) => `${Number.isInteger(n) ? n.toFixed(1) : n}f32`).join(", ");
    expect(meetingHudRs).toContain(`(${rust})`);
    expect(meetingHudRs).toContain(`cubic-bezier(${EASE_OUT.join(", ")})`);
  });

  it("UI durations stay under the 300ms ceiling", () => {
    for (const name of ["sr-t-fast", "sr-t-med", "sr-t-slow"]) {
      const match = new RegExp(`--${name}:\\s*(\\d+)ms`).exec(primitives);
      expect(match, `--${name} is missing`).not.toBeNull();
      expect(Number(match?.[1])).toBeLessThan(300);
    }
  });
});
