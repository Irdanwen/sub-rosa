import { afterEach, describe, expect, it } from "vitest";
import {
  applyLocale,
  initLocale,
  intlLocale,
  LOCALE_STORAGE_KEY,
  localeChoice,
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
