import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../../website/src/App";
import { setWebsiteLocale } from "../../website/src/lib/i18n";
import { createSitePaths } from "../../website/src/lib/paths";
import {
  categories,
  families,
  familyBySlug,
  priceLine,
  snapshot,
} from "../../website/src/models/catalog";
import { loadModelCatalog } from "../../website/src/models/loader";
import { defaults, needs } from "../../website/src/models/needs";

// Search embeddings serve Sub Rosa's memory and are never chosen by a person.
const chosenByPeople = snapshot.models.filter((model) => model.type !== "embedding");

/** Every sentence a reader can see, in both languages. */
const copy = () =>
  [
    ...families.flatMap((family) => [
      family.summary,
      ...family.strengths,
      ...family.limits,
      ...family.facts,
      ...(family.variants ?? []).map((variant) => variant.note),
    ]),
    ...needs.flatMap((need) => [need.question, need.why, need.alternative?.why ?? ["x", "x"]]),
    ...defaults.flatMap((item) => [item.task, item.why]),
    ...categories.flatMap((category) => [category.title, category.description]),
  ] as (readonly [string, string])[];

describe("model catalog", () => {
  it("files every model a person can pick under exactly one family", () => {
    const seen = new Map<string, string>();
    for (const family of families)
      for (const id of family.ids) {
        expect(seen.get(id), `${id} sits in ${seen.get(id)} and ${family.slug}`).toBeUndefined();
        seen.set(id, family.slug);
      }
    const missing = chosenByPeople.filter((model) => !seen.has(model.id)).map((model) => model.id);
    expect(missing, "refresh families.json after update-models.mjs").toEqual([]);
    const known = new Set(snapshot.models.map((model) => model.id));
    const stale = [...seen.keys()].filter((id) => !known.has(id));
    expect(stale, "these models left the catalog").toEqual([]);
  });

  it("recommends a real version and points every answer at a real family", () => {
    expect(new Set(families.map((family) => family.slug)).size).toBe(families.length);
    for (const family of families) {
      expect(family.ids).toContain(family.pick);
      for (const variant of family.variants ?? []) expect(family.ids).toContain(variant.id);
      expect(family.strengths.length).toBeGreaterThanOrEqual(2);
      expect(family.limits.length).toBeGreaterThanOrEqual(1);
      expect(family.sources.length).toBeGreaterThanOrEqual(1);
      if (family.url) expect(family.url).toMatch(/^https:\/\//);
    }
    for (const need of needs) {
      expect(familyBySlug(need.pick)?.category, need.id).toBe(need.category);
      if (need.alternative)
        expect(familyBySlug(need.alternative.slug)?.category, need.id).toBe(need.category);
    }
    for (const item of defaults) expect(familyBySlug(item.slug)?.ids).toContain(item.model);
    for (const category of categories)
      expect(
        needs.some((need) => need.category === category.id),
        category.id,
      ).toBe(true);
  });

  it("gives a price a reader can picture for every recommended version", () => {
    setWebsiteLocale("en");
    const unpriced = families
      .filter((family) => !priceLine(snapshot.models.find((model) => model.id === family.pick)))
      .map((family) => family.slug);
    // Tools priced by the job, and versions the catalog lists without a price.
    expect(unpriced.length).toBeLessThanOrEqual(3);
  });

  it("writes every sentence in both languages without typographic dashes", () => {
    for (const [en, fr] of copy()) {
      expect(en.trim(), fr).not.toBe("");
      expect(fr.trim(), en).not.toBe("");
      expect(`${en} ${fr}`, en).not.toMatch(/[–—]/);
      expect(fr, en).not.toMatch(/'/);
    }
  });

  it("routes the catalog and every family in both locales", () => {
    const site = createSitePaths("/subrosa/", "https://accounts.example");
    const origin = "https://marketing.example";
    for (const path of ["/subrosa/models", "/subrosa/fr/models"])
      expect(site.handles(new URL(path, origin), origin)).toBe(true);
    for (const family of families)
      expect(site.handles(new URL(`/subrosa/fr/models/${family.slug}`, origin), origin)).toBe(true);
  });

  it("renders the French catalog and a family page on direct navigation", async () => {
    await loadModelCatalog();
    setWebsiteLocale("fr");
    const home = renderToString(<App initialPath="/fr/models" />);
    expect(home).toContain("Choisissez le bon modèle.");
    expect(home).toContain("/fr/models/glm");
    const page = renderToString(<App initialPath="/fr/models/glm" />);
    expect(page).toContain("Notre choix dans cette famille");
    expect(page).toContain("zai-org-glm-5-2");
    const missing = renderToString(<App initialPath="/fr/models/nothing-here" />);
    expect(missing).toContain("Ce modèle est introuvable.");
  });
});
