import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * iOS zooms into any field whose text is under 16px and never zooms back, so
 * one 15px input leaves the whole phone shell cropped at the right edge. The
 * floor lives in one guard in mobile.css; a later rule that targets a field
 * and restates a smaller size silently wins over it (the memory input did,
 * at --fs-md, which is 15px on the phone).
 */
const css = readFileSync("src/styles/mobile.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rules(source) {
  const found = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of source.matchAll(pattern)) {
    found.push({ selector: match[1].replace(/\s+/g, " ").trim(), body: match[2] });
  }
  return found;
}

const FIELD = /(^|[\s>+~,(])(input|textarea|select)\b|\[contenteditable/;
const SAFE = /max\(16px|--fs-(lg|xl|2xl|display)\b|^(1[6-9]|[2-9]\d)px$/;

describe("mobile field text size", () => {
  it("keeps the 16px floor for fields and rich-text surfaces", () => {
    expect(css).toMatch(
      /\.mobile-shell input,\s*\.mobile-shell textarea,\s*\.mobile-shell select\s*\{\s*font-size: max\(16px/,
    );
    expect(css).toMatch(/\.mobile-shell \[contenteditable="true"\]\s*\{\s*font-size: max\(16px/);
  });

  it("never restates a field size under 16px", () => {
    const offenders = rules(css)
      .filter((rule) => FIELD.test(rule.selector))
      .flatMap((rule) =>
        [...rule.body.matchAll(/font-size:\s*([^;]+);/g)]
          .map((declaration) => declaration[1].trim())
          .filter((value) => !SAFE.test(value))
          .map((value) => `${rule.selector} => ${value}`),
      );
    expect(offenders).toEqual([]);
  });

  it("sizes the document to the screen, not to the desktop floor", () => {
    expect(css).toMatch(/:root\[data-shell="mobile"\] body\s*\{[^}]*min-width: 0/);
  });
});
