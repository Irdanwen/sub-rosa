import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import { placeholders } from "../lib/i18n";

/**
 * The gate that makes the French complete (ADR-0047): every sentence the
 * code says has a French sentence with the same placeholders. A new
 * sentence is a red test until it is translated; `pnpm i18n:extract`
 * keeps the two files in step with the code.
 */
describe("the French catalog", () => {
  const sentences = Object.keys(en);

  it("has every sentence the code says, and nothing else", () => {
    const missing = sentences.filter((sentence) => !(sentence in fr));
    const extra = Object.keys(fr).filter((sentence) => !(sentence in en));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("translates every sentence", () => {
    const untranslated = sentences.filter((sentence) => !(fr as Record<string, string>)[sentence]);
    expect(untranslated).toEqual([]);
  });

  it("keeps every placeholder", () => {
    const broken = sentences
      .map((sentence) => ({
        sentence,
        expected: placeholders(sentence),
        actual: placeholders((fr as Record<string, string>)[sentence] ?? ""),
      }))
      .filter((entry) => entry.expected.join() !== entry.actual.join());
    expect(broken).toEqual([]);
  });
});
