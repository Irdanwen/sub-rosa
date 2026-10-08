import { afterEach, describe, expect, it } from "vitest";
import {
  applyLocale,
  initLocale,
  intlLocale,
  LOCALE_STORAGE_KEY,
  localeChoice,
  localeFromTag,
  placeholders,
  resolveLocale,
  setLocaleChoice,
  t,
} from "../lib/i18n";

describe("t", () => {
  afterEach(() => {
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    applyLocale("en");
  });

  it("returns the English sentence as written when the language is English", () => {
    applyLocale("en");
    expect(t("Export as PDF")).toBe("Export as PDF");
    expect(t("{count} steps", { count: 3 })).toBe("3 steps");
  });

  it("translates a sentence the catalog has, and keeps one it does not", () => {
    applyLocale("fr");
    expect(t("Export as PDF")).toBe("Exporter en PDF");
    expect(t("A sentence no catalog will ever hold")).toBe("A sentence no catalog will ever hold");
  });

  it("fills placeholders in the translation, in the translation's order", () => {
    applyLocale("fr");
    expect(t("{satisfied} of {total} criteria hold", { satisfied: 2, total: 5 })).toBe(
      "2 critères sur 5 tiennent",
    );
    expect(t("Hello {name}", { other: "x" })).toBe("Hello {name}");
  });

  it("stores a choice, resolves 'system' from the device, and picks the Intl tag", () => {
    setLocaleChoice("fr");
    expect(localeChoice()).toBe("fr");
    expect(intlLocale()).toBe("fr-FR");
    setLocaleChoice("system");
    expect(localeChoice()).toBe("system");
    expect(["en", "fr"]).toContain(resolveLocale("system"));
    expect(initLocale()).toBe(resolveLocale("system"));
  });

  it("lists the placeholders of a sentence, sorted", () => {
    expect(placeholders("{total} of {count}")).toEqual(["count", "total"]);
    expect(placeholders("none")).toEqual([]);
  });
});

describe("the languages beyond English and French", () => {
  afterEach(() => {
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    applyLocale("en");
  });

  it("reduces a system tag to a language the app has", () => {
    expect(localeFromTag("de-CH")).toBe("de");
    expect(localeFromTag("it_IT")).toBe("it");
    expect(localeFromTag("es-419")).toBe("es");
    expect(localeFromTag("pt-BR")).toBe("pt-BR");
    expect(localeFromTag("pt-PT")).toBe("pt-BR");
    expect(localeFromTag("fr-CA")).toBe("fr");
    expect(localeFromTag("ja-JP")).toBe("en");
  });

  it("translates, dates and numbers in each language, and says it on the page", () => {
    for (const [locale, tag] of [
      ["de", "de-DE"],
      ["it", "it-IT"],
      ["es", "es-ES"],
      ["pt-BR", "pt-BR"],
    ] as const) {
      setLocaleChoice(locale);
      expect(localeChoice()).toBe(locale);
      expect(intlLocale()).toBe(tag);
      expect(document.documentElement.lang).toBe(locale);
      expect(t("Export as PDF")).not.toBe("Export as PDF");
      expect(t("{count} steps", { count: 3 })).toContain("3");
    }
  });
});
