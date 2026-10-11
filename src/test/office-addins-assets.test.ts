// @ts-expect-error node:fs is available in the Vitest runtime.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The panes' origin serves only what the office build writes: its own
 * `office-addins/public` and the hashed chunks under `/office/assets/`. An
 * absolute `url(/…)` in the panes' CSS is left alone by the build, so it must
 * name a file of that public directory, or production answers 404 (the
 * panes fell back to a system font until 2026-10-11 because the site's
 * `/fonts/inter-latin.woff2` was named here).
 */
describe("Office pane stylesheet", () => {
  const css = readFileSync("office-addins/src/office.css", "utf8") as string;
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);

  it("names at least the font it uses", () => {
    expect(urls.some((url) => url.endsWith("inter-latin.woff2"))).toBe(true);
  });

  it("only points at files the build can serve", () => {
    for (const url of urls) {
      if (url.startsWith("data:")) continue;
      const file = url.startsWith("/")
        ? `office-addins/public${url}`
        : new URL(url, "file:///repo/office-addins/src/").pathname.replace("/repo/", "");
      expect(existsSync(file), `${url} -> ${file}`).toBe(true);
    }
  });
});
