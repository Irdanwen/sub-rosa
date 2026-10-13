import { describe, expect, it } from "vitest";
import preferencesCss from "../styles/preferences.css?raw";

// Every frosted surface on the desktop has a solid answer when the system asks
// for reduced transparency (preferences.css). A new glass rule without one
// fails here: blur is the first thing a person who switched the setting on
// notices is still there. The phone's glass is answered next to it in
// mobile.css, which this guard leaves alone.
const stylesheets = import.meta.glob(["../styles/*.css", "../components/**/*.css"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const SKIP = new Set(["../styles/mobile.css", "../styles/preferences.css"]);

function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Selectors of the rules that declare a backdrop-filter other than none. */
function glassSelectors(css: string) {
  const found: string[] = [];
  for (const rule of withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const filter = /(?:^|;)\s*backdrop-filter:\s*([^;]+)/.exec(rule[2]);
    if (!filter || filter[1].trim() === "none") continue;
    for (const selector of rule[1].split(",")) found.push(selector.trim().replace(/\s+/g, " "));
  }
  return found;
}

function block(css: string, query: string) {
  const start = css.indexOf(`@media (${query})`);
  if (start < 0) return "";
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, index);
  }
  return css.slice(start);
}

describe("the system preferences", () => {
  const reduced = withoutComments(block(preferencesCss, "prefers-reduced-transparency: reduce"));
  const answered = new Set(
    [...reduced.matchAll(/([^{}]+)\{[^{}]*backdrop-filter:\s*none/g)].flatMap((match) =>
      match[1].split(",").map((selector) =>
        selector
          .trim()
          .replace(/^:root\s+/, "")
          .replace(/\s+/g, " "),
      ),
    ),
  );

  it("turns every desktop glass surface solid under reduced transparency", () => {
    const missing = Object.entries(stylesheets)
      .filter(([path]) => !SKIP.has(path))
      .flatMap(([path, css]) =>
        glassSelectors(css)
          .filter((selector) => !answered.has(selector))
          .map((selector) => `${path.slice(3)}: ${selector}`),
      );
    expect(missing).toEqual([]);
  });

  it("draws a real focus line and stronger hairlines when more contrast is asked for", () => {
    const contrast = withoutComments(block(preferencesCss, "prefers-contrast: more"));
    expect(contrast).toMatch(/--border:/);
    expect(contrast).toMatch(/--muted-foreground:/);
    expect(contrast).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  });
});
