import { describe, expect, it } from "vitest";
import mobileCss from "../styles/mobile.css?raw";
import tokensCss from "../styles/tokens.css?raw";

/**
 * The mobile chat's opening plays a dark image behind the greeting, so that
 * subtree is re-grounded to the ink palette whatever theme the app is in.
 * tokens.css does that by listing `.mobile-chat[data-ambient="true"]` next to
 * `[data-theme="dark"]`, which covers every token the dark block declares.
 *
 * It does NOT cover tokens derived from those. A custom property is computed
 * on the element that declares it, so `--brand-tint`, declared once on :root
 * out of `--card`, keeps its light value inside a subtree however dark the
 * subtree says it is. Those are redeclared in mobile.css, and the failure mode
 * when one is missed is quiet and ugly: a pale chip with white text on it.
 *
 * So this test derives the list rather than trusting one. Add a token to :root
 * that reads an overridden base and this turns red with its name.
 */

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`No rule for ${selector}`);
  let depth = 0;
  for (let i = at; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(at, i + 1);
    }
  }
  throw new Error(`Unclosed rule for ${selector}`);
}

function declaredIn(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

const root = declaredIn(ruleBody(tokensCss, ":root"));
// The dark palette is one rule with two selectors; the ambient scope is the
// second, which is what makes this whole arrangement work.
const dark = declaredIn(
  ruleBody(tokensCss, '[data-theme="dark"],\n.mobile-chat[data-ambient="true"]'),
);
const ambient = declaredIn(ruleBody(mobileCss, '.mobile-chat[data-ambient="true"]'));

describe("the chat's ambient scope", () => {
  it("shares the dark palette rather than restating one", () => {
    expect(tokensCss).toContain('[data-theme="dark"],\n.mobile-chat[data-ambient="true"] {');
    // A palette copied into mobile.css is the drift this guards against.
    expect(dark.get("--background")).toBeDefined();
    expect(dark.get("--foreground")).toBeDefined();
  });

  /**
   * Tokens the ambient scope sets on purpose, rather than because a derivation
   * forced it. Each one is a decision about this ground specifically, so each
   * one is named here: adding to this list is meant to be a conscious act, not
   * something a stray declaration slips past.
   */
  const DELIBERATE_OVERRIDES = new Map([
    // Vibrancy. The clip's own light leaves no room for a grey secondary tone —
    // nothing quieter than this clears 4.5:1 even where the water is darkest.
    ["--muted-foreground", "a lifted secondary tone, see mobile.css"],
  ]);

  /** Tokens :root builds out of a base the dark palette replaces. */
  const derived = [...root.entries()]
    .filter(([name]) => !dark.has(name))
    .filter(([, value]) =>
      [...(value.matchAll(/var\((--[a-z0-9-]+)\)/g) as Iterable<RegExpMatchArray>)].some((match) =>
        dark.has(match[1]),
      ),
    )
    .map(([name]) => name)
    .sort();

  it("redeclares every token that derives from a base the dark palette overrides", () => {
    // Sanity: if this ever computes to nothing the test has stopped testing.
    expect(derived.length).toBeGreaterThan(0);
    for (const name of derived) {
      expect(ambient.has(name), `${name} re-derives from a replaced base`).toBe(true);
    }
  });

  it("sets nothing else without saying so", () => {
    const unexplained = [...ambient.keys()].filter(
      (name) => !derived.includes(name) && !DELIBERATE_OVERRIDES.has(name),
    );
    expect(unexplained).toEqual([]);
  });

  it("re-derives with the same recipe, not a hand-picked value", () => {
    // The point of a re-derivation is to run :root's own formula against the
    // ink palette. A literal here would be a second palette in disguise, and
    // would stop tracking the accent. Deliberate overrides are exempt: a
    // literal is exactly what they are.
    for (const name of derived) {
      expect(ambient.get(name), `${name} should reuse its :root recipe`).toBe(root.get(name));
    }
  });
});
