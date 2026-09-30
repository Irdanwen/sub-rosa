import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../../website/src/App";
import { setWebsiteLocale } from "../../website/src/lib/i18n";
import { createSitePaths } from "../../website/src/lib/paths";
import { categories, guides, searchGuides } from "../../website/src/pages/docs-content";

describe("public documentation", () => {
  it("has a stable route for every article in both locales", () => {
    expect(new Set(guides.map((guide) => guide.slug)).size).toBe(guides.length);
    expect(guides.length).toBeGreaterThanOrEqual(18);
    const categoryIds = new Set(categories.map((category) => category.id));
    const slugs = new Set(guides.map((guide) => guide.slug));
    const site = createSitePaths("/subrosa/", "https://accounts.example");
    for (const guide of guides) {
      expect(categoryIds.has(guide.category)).toBe(true);
      expect(guide.sections.length).toBeGreaterThan(0);
      for (const related of guide.related ?? []) expect(slugs.has(related)).toBe(true);
      for (const path of [`/subrosa/docs/${guide.slug}`, `/subrosa/fr/docs/${guide.slug}`]) {
        expect(
          site.handles(new URL(path, "https://marketing.example"), "https://marketing.example"),
        ).toBe(true);
      }
    }
  });

  it("searches article content in the selected language", () => {
    setWebsiteLocale("en");
    expect(searchGuides("recovery kit").map((guide) => guide.slug)).toContain("recovery");
    setWebsiteLocale("fr");
    expect(searchGuides("synchronisation chiffrée").map((guide) => guide.slug)).toContain("sync");
    expect(searchGuides("unmotquinnexistepas")).toEqual([]);
  });

  it("renders French article content on direct navigation", () => {
    setWebsiteLocale("fr");
    const html = renderToString(<App initialPath="/fr/docs/first-note" />);
    expect(html).toContain("Créer votre première note");
    expect(html).toContain("/fr/docs/install");
    expect(html).toContain('href="#write"');
  });
});
