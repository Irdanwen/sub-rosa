import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { App } from "../../website/src/App";
import { setWebsiteLocale } from "../../website/src/lib/i18n";
import {
  type Category,
  type PriceUnit,
  categories,
  formatUsd,
  modelsOfCategory,
  usdPrice,
} from "../../website/src/models/catalog";
import { loadModelCatalog } from "../../website/src/models/loader";
import { priceKind } from "../../website/src/pages/models/prices";

// The price table speaks dollars, one unit per kind of price. A unit that
// does not belong to its kind of work would compare a track with a minute.
const units: Record<Category, PriceUnit[]> = {
  text: ["tokens"],
  transcription: ["hour"],
  image: ["image", "upscale"],
  edit: ["edit"],
  video: ["second"],
  voice: ["characters", "sound"],
  music: ["track", "minute", "sound"],
  effects: ["sound", "track", "minute"],
};

beforeAll(async () => {
  await loadModelCatalog();
});
afterEach(() => setWebsiteLocale("en"));

describe("the price comparison", () => {
  it("prices every model in the unit of its kind of work", () => {
    let priced = 0;
    for (const category of categories)
      for (const row of modelsOfCategory(category.id)) {
        const price = usdPrice(row.model);
        if (!price) continue;
        priced += 1;
        expect(units[category.id], `${row.model.id} (${price.unit})`).toContain(price.unit);
        expect(price.value, row.model.id).toBeGreaterThan(0);
        if (price.unit === "tokens") expect(price.input, row.model.id).toBeGreaterThan(0);
      }
    expect(priced).toBeGreaterThan(300);
  });

  it("reads its kind of work from the address, text by default", () => {
    expect(priceKind("")).toBe("text");
    expect(priceKind("?k=video")).toBe("video");
    expect(priceKind("?k=nothing")).toBe("text");
  });

  it("renders every kind with real dollar prices and no style attribute", () => {
    for (const category of categories) {
      setWebsiteLocale("fr");
      const html = renderToString(<App initialPath={`/fr/models/prices?k=${category.id}`} />);
      expect(html, category.id).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
      expect(html, category.id).not.toMatch(/ style="/);
      expect(html).toContain("Chaque modèle, chaque prix.");
      const first = modelsOfCategory(category.id).find((row) => row.price);
      if (first?.price) expect(html, category.id).toContain(formatUsd(first.price.value));
    }
    setWebsiteLocale("en");
    const html = renderToString(<App initialPath="/models/prices" />);
    expect(html).toContain("Every model, every price.");
    expect(html).toContain("per million tokens");
  });

  it("puts the price comparison one click from the hub and from each kind", () => {
    setWebsiteLocale("fr");
    expect(renderToString(<App initialPath="/fr/models" />)).toContain('href="/fr/models/prices"');
    expect(renderToString(<App initialPath="/fr/models/video" />)).toContain(
      'href="/fr/models/prices?k=video"',
    );
  });
});
