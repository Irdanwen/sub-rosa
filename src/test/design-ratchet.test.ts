import { describe, expect, it } from "vitest";
import ratchet from "../../design-ratchet.json";

// The stylesheets may only get more systematic.
//
// Colours belong to tokens.css and stacking layers to its --z-* scale. The
// codebase predates both rules in places, so every stylesheet that still
// writes a raw hex colour, or a raw z-index of 10 or more (a cross-surface
// layer, as opposed to a component's local 1-6), is listed in
// design-ratchet.json with the count it had when this guard was written. A
// change that adds one fails here; when a count drops, lower its entry
// (delete it at zero). New stylesheets start at zero.
//
// Sources are read through Vite (import.meta.glob), never node:fs: the test
// tsconfig has no @types/node.
const stylesheets = import.meta.glob("../**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** tokens.css is where colours are defined, so it is the one exemption. */
const EXEMPT = new Set(["src/styles/tokens.css"]);

function repoPath(key: string) {
  return `src/${key.slice("../".length)}`;
}

function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function rawHexCount(css: string) {
  return (withoutComments(css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length;
}

function rawLayerCount(css: string) {
  return (withoutComments(css).match(/z-index:\s*(\d+)/g) ?? []).filter(
    (declaration) => Number(declaration.replace(/\D/g, "")) >= 10,
  ).length;
}

describe("the design ratchet", () => {
  const hexAllowed: Record<string, number> = ratchet.rawHex;
  const layersAllowed: Record<string, number> = ratchet.rawLayers;

  const sheets = Object.entries(stylesheets)
    .map(([key, css]) => ({ path: repoPath(key), css }))
    .filter(({ path }) => !EXEMPT.has(path) && !path.startsWith("src/test/"));

  it("adds no raw hex colour outside tokens.css", () => {
    const offenders = sheets
      .map(({ path, css }) => ({ path, count: rawHexCount(css), allowed: hexAllowed[path] ?? 0 }))
      .filter(({ count, allowed }) => count > allowed)
      .map(({ path, count, allowed }) => `${path}: ${count} raw colours (allowed ${allowed})`);
    expect(offenders).toEqual([]);
  });

  it("names every cross-surface layer from the --z-* scale", () => {
    const offenders = sheets
      .map(({ path, css }) => ({
        path,
        count: rawLayerCount(css),
        allowed: layersAllowed[path] ?? 0,
      }))
      .filter(({ count, allowed }) => count > allowed)
      .map(({ path, count, allowed }) => `${path}: ${count} raw layers (allowed ${allowed})`);
    expect(offenders).toEqual([]);
  });

  it("keeps the recorded counts honest, so a cleanup lowers the ceiling", () => {
    const stale: string[] = [];
    const byPath = new Map(sheets.map((sheet) => [sheet.path, sheet.css]));
    for (const [path, allowed] of Object.entries(hexAllowed)) {
      const css = byPath.get(path);
      if (css === undefined || rawHexCount(css) < allowed) stale.push(`rawHex ${path}`);
    }
    for (const [path, allowed] of Object.entries(layersAllowed)) {
      const css = byPath.get(path);
      if (css === undefined || rawLayerCount(css) < allowed) stale.push(`rawLayers ${path}`);
    }
    expect(stale).toEqual([]);
  });
});
