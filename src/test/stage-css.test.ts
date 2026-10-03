/**
 * The stage's stylesheet, pinned where a regression would be silent: the
 * veil only reads over the picture with the rules below, the reveal only
 * wipes with its keyframes, and reduced motion must keep the words and drop
 * the movement. The last case walks the components that use `stage-*`
 * classes and fails on a class with no rule - the mobile-classes test does
 * this for `mobile-*`, and these classes live in a different file.
 */

import { describe, expect, it } from "vitest";
import stageCss from "../components/studio/stage/stage.css?raw";

// Sources are read through Vite, never node:fs: `src/test` is typechecked
// with the browser lib.
const SOURCES = import.meta.glob(
  ["../components/studio/**/*.tsx", "../components/mobile/**/*.tsx", "../app/mobile/**/*.tsx"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function cssRuleFor(selector: string, css = stageCss) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*\\{`, "m").exec(css);
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  const openIndex = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Unclosed CSS rule for ${selector}`);
}

describe("the stage stylesheet", () => {
  it("lays the veil over the picture, in its own stacking context", () => {
    const veil = cssRuleFor(".stage-veil");
    // The lights blend in screen mode; without isolation they would blend
    // with whatever sits under the frame rather than with the picture.
    expect(veil).toContain("isolation: isolate;");
    expect(veil).toContain("background: color-mix(in oklch, var(--screen) 38%, transparent);");
    expect(cssRuleFor(".stage-veil .darkroom-field")).toContain("mix-blend-mode: screen;");
  });

  it("wipes a result in, and holds it invisible until it is decoded", () => {
    expect(cssRuleFor('.stage-reveal[data-reveal="waiting"]')).toContain("opacity: 0;");
    expect(cssRuleFor('.stage-reveal[data-reveal="true"]')).toContain("stage-wipe");
    expect(stageCss).toMatch(/@keyframes stage-wipe/);
    expect(stageCss).toMatch(/@keyframes stage-shimmer/);
  });

  it("keeps the words and drops the movement under reduced motion", () => {
    const reduced = stageCss.slice(stageCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.stage-reveal\[data-reveal="true"\]\s*\{\s*animation: stage-fade/);
    expect(reduced).toMatch(/\.stage-veil,\s*\.stage-pending\s*\{\s*animation: none;/);
    // The blank canvas is still: its light is decoration, not progress.
    expect(reduced).toMatch(
      /\.stage-idle \.darkroom-field,\s*\.stage-idle \.darkroom-light,\s*\.stage-idle \.darkroom-grain\s*\{\s*animation: none;/,
    );
  });

  it("gives every stage class a component uses a rule", () => {
    const used = new Set<string>();
    for (const source of Object.values(SOURCES)) {
      // A class, not a custom property: `--stage-aspect` is set in a style.
      for (const match of source.matchAll(/(?<![-\w])stage-[a-z0-9-]+/g)) used.add(match[0]);
    }
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter(
      (name) => !new RegExp(`\\.${name}(?![a-z0-9-])`).test(stageCss),
    );
    expect(missing).toEqual([]);
  });
});
