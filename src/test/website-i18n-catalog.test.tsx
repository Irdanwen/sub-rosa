import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { App } from "../../website/src/App";
import {
  initialWebsiteLocale,
  LOCALE_NAMES,
  loadWebsiteMessages,
  localizedPublicPath,
  requestedWebsiteLocale,
  requireWebsiteMessages,
  SITE_LOCALES,
  type SiteLocale,
  setWebsiteLocale,
  siteLocaleFromTag,
  splitLocalePath,
  t,
} from "../../website/src/lib/i18n";
import { createSitePaths, localizedSiteHref } from "../../website/src/lib/paths";
import { categories } from "../../website/src/models/catalog";
import { loadDetails } from "../../website/src/models/details";
import { loadModelCatalog } from "../../website/src/models/loader";
import { pageMeta } from "../../website/src/pages/meta";
// @ts-expect-error: a plain ES module script without types.
import * as extractor from "../../scripts/i18n/website.mjs";

/**
 * The website speaks the app's six languages (ADR-0047, website addendum).
 * English and French are written in the code as pairs; the four others
 * come from catalogs keyed by the English, and this is their gate: every
 * sentence the site can show is translated in every catalog, with the same
 * placeholders and no typographic dash. A new `t("…", "…")` is a red test
 * until `pnpm --filter @subrosa/website i18n:extract` has run and the
 * sentence is translated four times.
 */

const TRANSLATED = SITE_LOCALES.filter((locale) => locale !== "en" && locale !== "fr");
const collected = extractor.collectWebsiteSentences();
const catalogFile = (part: string, locale: string) =>
  import.meta.glob<Record<string, string>>("../../website/src/locales/**/*.json", {
    eager: true,
    import: "default",
  })[
    `../../website/src/locales/${part === "site" ? "" : `${part.replace(":", "/")}/`}${locale}.json`
  ];

describe("the website's catalogs", () => {
  it("know the same languages as the site", () => {
    expect([...extractor.WEBSITE_LOCALES].sort()).toEqual([...TRANSLATED].sort());
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...SITE_LOCALES].sort());
  });

  it("find the English of every t() call and every Copy pair", () => {
    expect(collected.problems).toEqual([]);
    const total = extractor.PARTS.reduce(
      (sum: number, part: string) => sum + collected.byPart[part].length,
      0,
    );
    expect(total).toBeGreaterThan(4000);
  });

  for (const locale of TRANSLATED)
    it(`hold every sentence in ${locale}, translated, and nothing else`, () => {
      for (const part of extractor.PARTS) {
        const catalog = catalogFile(part, locale) ?? {};
        const keys: string[] = collected.byPart[part];
        const missing = keys.filter((key) => !catalog[key]);
        const extra = Object.keys(catalog).filter((key) => !keys.includes(key));
        expect({ part, missing, extra }).toEqual({ part, missing: [], extra: [] });
      }
    });

  it("pass the quality gate: placeholders, dashes, product names, nothing left in English", () => {
    const { errors } = extractor.verifyWebsiteCatalogs(collected);
    expect(errors).toEqual([]);
  });
});

describe("t in the four catalog languages", () => {
  beforeAll(() => loadWebsiteMessages("de"));
  afterEach(() => setWebsiteLocale("en"));

  it("keeps English and French in the code and reads the others from the catalog", () => {
    setWebsiteLocale("en");
    expect(t("Download", "Télécharger")).toBe("Download");
    setWebsiteLocale("fr");
    expect(t("Download", "Télécharger")).toBe("Télécharger");
    setWebsiteLocale("de");
    expect(t("Download", "Télécharger")).toBe(catalogFile("site", "de")?.Download);
    expect(t("Download", "Télécharger")).not.toBe("Download");
  });

  it("matches a filled template back to its key and fills the translation", () => {
    setWebsiteLocale("de");
    const key = "{count} guides found";
    const translation = catalogFile("site", "de")?.[key] ?? "";
    expect(translation).toContain("{count}");
    expect(t("7 guides found", "7 guides trouvés")).toBe(translation.replace("{count}", "7"));
  });

  it("tells apart the French readings of one English word", () => {
    setWebsiteLocale("de");
    const catalog = catalogFile("app", "de") ?? catalogFile("site", "de") ?? {};
    const card = catalog["Back [fr: Verso]"] ?? catalogFile("site", "de")?.["Back [fr: Verso]"];
    const navigation =
      catalog["Back [fr: Retour]"] ?? catalogFile("site", "de")?.["Back [fr: Retour]"];
    expect(card).toBeTruthy();
    expect(navigation).toBeTruthy();
    expect(t("Back", "Verso")).toBe(card);
    expect(t("Back", "Retour")).toBe(navigation);
  });

  it("leaves a sentence no catalog has in English", () => {
    setWebsiteLocale("de");
    expect(t("Kling 2.5 Turbo Pro", "Kling 2.5 Turbo Pro")).toBe("Kling 2.5 Turbo Pro");
  });
});

describe("languages and routes", () => {
  beforeEach(() => localStorage.clear());

  it("reduces a browser's languages to one the site speaks", () => {
    expect(siteLocaleFromTag("de-CH")).toBe("de");
    expect(siteLocaleFromTag("pt-PT")).toBe("pt-BR");
    expect(siteLocaleFromTag("ja-JP")).toBeNull();
    expect(initialWebsiteLocale("/account", "", ["ja-JP", "it-CH", "en-US"])).toBe("it");
    expect(initialWebsiteLocale("/account", "", "es-MX")).toBe("es");
    expect(initialWebsiteLocale("/account", "lang=pt-br", "en-US")).toBe("pt-BR");
    expect(requestedWebsiteLocale("lang=xx")).toBeNull();
    expect(initialWebsiteLocale("/pt-br/docs", "", "en-US")).toBe("pt-BR");
  });

  it("gives every public page a path in every language, and recognizes it", () => {
    const site = createSitePaths("/subrosa/", "https://accounts.example");
    const origin = "https://marketing.example";
    for (const locale of SITE_LOCALES) {
      const docs = localizedPublicPath("/docs", locale);
      expect(splitLocalePath(docs)).toEqual({
        locale: locale === "en" ? null : locale,
        page: "/docs",
      });
      for (const page of ["/", "/downloads", "/docs/install", "/models", "/models/glm"])
        expect(
          site.handles(new URL(`/subrosa${localizedPublicPath(page, locale)}`, origin), origin),
          `${locale} ${page}`,
        ).toBe(true);
    }
    expect(localizedSiteHref("/docs", "pt-BR")).toBe("/pt-br/docs");
    expect(localizedSiteHref("/", "de")).toBe("/de/");
    expect(localizedSiteHref("/account", "it")).toBe("/account?lang=it");
    expect(site.handles(new URL("/subrosa/de/account", origin), origin)).toBe(false);
  });
});

describe("a rendered page in each language", () => {
  beforeAll(async () => {
    await loadModelCatalog();
    await Promise.all(categories.map((category) => loadDetails(category.id)));
    requireWebsiteMessages("app", "en");
    for (const locale of SITE_LOCALES) await loadWebsiteMessages(locale);
  });
  afterEach(() => setWebsiteLocale("en"));

  const home = (locale: SiteLocale) => {
    setWebsiteLocale(locale);
    return t("Make space for what matters.", "Faites place à l’essentiel.");
  };

  for (const locale of SITE_LOCALES)
    it(`renders the home page, a guide and a model family in ${locale}`, () => {
      const heading = home(locale);
      if (locale !== "en") expect(heading).not.toBe("Make space for what matters.");
      setWebsiteLocale(locale);
      const page = renderToString(<App initialPath={localizedPublicPath("/", locale)} />);
      expect(page).toContain(heading.replace(/'/g, "&#x27;"));
      setWebsiteLocale(locale);
      const family = renderToString(
        <App initialPath={localizedPublicPath("/models/glm", locale)} />,
      );
      expect(family, locale).not.toMatch(/NaN|undefined|\[object Object\]| style="/);
      setWebsiteLocale(locale);
      const { title, description } = pageMeta("/models/glm");
      expect(title).toContain("GLM");
      if (locale !== "en" && locale !== "fr") {
        expect(title).not.toContain("Model catalog");
        expect(description.trim()).not.toBe("");
        setWebsiteLocale("en");
        expect(pageMeta("/models/glm").description).not.toBe(description);
      }
    });
});

describe("the language picker", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/docs");
  });
  afterEach(() => {
    setWebsiteLocale("en");
    history.replaceState(null, "", "/");
  });

  it("lists the six languages by their own names and moves the page to the one chosen", async () => {
    setWebsiteLocale("en");
    render(<App initialPath="/docs" />);
    const picker = screen.getByRole("combobox", { name: "Website language" });
    expect(Array.from(picker.querySelectorAll("option"), (option) => option.textContent)).toEqual(
      SITE_LOCALES.map((locale) => LOCALE_NAMES[locale]),
    );
    fireEvent.change(picker, { target: { value: "de" } });
    await loadWebsiteMessages("de");
    setWebsiteLocale("de");
    const label = t("Website language", "Langue du site");
    expect(await screen.findByRole("combobox", { name: label })).toHaveValue("de");
    expect(location.pathname).toBe("/de/docs");
  });
});
