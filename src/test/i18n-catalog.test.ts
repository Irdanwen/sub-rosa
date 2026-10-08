import { describe, expect, it } from "vitest";
import de from "../locales/de.json";
import en from "../locales/en.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import it_ from "../locales/it.json";
import ptBR from "../locales/pt-BR.json";
import { placeholders, SUPPORTED_LOCALES } from "../lib/i18n";
// @ts-expect-error: a plain ES module script without types.
import * as gate from "../../scripts/i18n/verify-catalogs.mjs";

const { TRANSLATED_LOCALES, verifyCatalog, verifyLocale, wordCount } = gate;

/**
 * The gate that makes every language complete (ADR-0047): every sentence
 * the code says has a translation with the same placeholders, in each
 * catalog. A new sentence is a red test until it is translated everywhere;
 * `pnpm i18n:extract` keeps the files in step with the code.
 */
const catalogs: Record<string, Record<string, string>> = {
  fr,
  de,
  it: it_,
  es,
  "pt-BR": ptBR,
};

describe("the language list", () => {
  it("has a catalog for every language the app offers, and the scripts know them all", () => {
    expect([...SUPPORTED_LOCALES].filter((locale) => locale !== "en").sort()).toEqual(
      Object.keys(catalogs).sort(),
    );
    expect([...TRANSLATED_LOCALES].sort()).toEqual(Object.keys(catalogs).sort());
  });
});

for (const [locale, catalog] of Object.entries(catalogs)) {
  describe(`the ${locale} catalog`, () => {
    const sentences = Object.keys(en);

    it("has every sentence the code says, and nothing else", () => {
      const missing = sentences.filter((sentence) => !(sentence in catalog));
      const extra = Object.keys(catalog).filter((sentence) => !(sentence in en));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it("translates every sentence", () => {
      const untranslated = sentences.filter((sentence) => !catalog[sentence]);
      expect(untranslated).toEqual([]);
    });

    it("keeps every placeholder", () => {
      const broken = sentences
        .map((sentence) => ({
          sentence,
          expected: placeholders(sentence),
          actual: placeholders(catalog[sentence] ?? ""),
        }))
        .filter((entry) => entry.expected.join() !== entry.actual.join());
      expect(broken).toEqual([]);
    });

    it("passes the quality gate: no dash, no lost product name, nothing left in English", () => {
      expect(verifyLocale(locale).errors).toEqual([]);
    });
  });
}

describe("the catalog quality gate", () => {
  const en = {
    "Open the note": "Open the note",
    "{count} notes": "{count} notes",
    "Sub Rosa keeps your notes on this device.": "Sub Rosa keeps your notes on this device.",
    "Run npm install first please": "Run npm install first please",
    OK: "OK",
  };
  const good = {
    "Open the note": "Notiz öffnen",
    "{count} notes": "{count} Notizen",
    "Sub Rosa keeps your notes on this device.":
      "Sub Rosa speichert deine Notizen auf diesem Gerät.",
    "Run npm install first please": "Run npm install first please",
    OK: "OK",
  };
  const glossary = { keep: ["Sub Rosa"], terms: { note: "Notiz" } };

  it("accepts a complete catalog, a short sentence left as written and an allowed one", () => {
    const result = verifyCatalog(en, good, {
      glossary,
      allowed: ["Run npm install first please"],
    });
    expect(result.errors).toEqual([]);
  });

  it("refuses what a translation must not do", () => {
    const bad = {
      "Open the note": "",
      "{count} notes": "{n} Notizen",
      "Sub Rosa keeps your notes on this device.": "Die App speichert deine Notizen – hier.",
      "Run npm install first please": "Run npm install first please",
      Extra: "Extra",
    };
    const problems = verifyCatalog(en, bad, { glossary })
      .errors.map((error: { problem: string }) => error.problem)
      .sort();
    expect(problems).toEqual(
      [
        "empty",
        "left in English",
        "missing",
        "not in en.json",
        "placeholders",
        "product name Sub Rosa lost",
        "typographic dash",
      ].sort(),
    );
  });

  it("warns, without failing, when a glossary term is missing", () => {
    const result = verifyCatalog(
      { "Delete the note": "Delete the note" },
      { "Delete the note": "Eintrag löschen" },
      { glossary },
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("counts words without placeholders or punctuation", () => {
    expect(wordCount("{count} of {total} - done")).toBe(2);
    expect(wordCount("Open the note now")).toBe(4);
  });
});
