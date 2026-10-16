import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../website/src/App";
import {
  FAMILY_COUNT,
  LANGUAGE_COUNT,
  PRICE_EXAMPLES,
  PRICES_CHECKED_AT,
  STUDIO_CREATION_CREDITS,
  STUDIO_CREATIONS,
  STUDIO_CREATIONS_MODEL,
} from "../../website/src/home-facts";
import { setWebsiteLocale, SITE_LOCALES } from "../../website/src/lib/i18n";
import families from "../../website/src/models/families.json";
import snapshot from "../../website/src/models/snapshot.json";

// The home page states numbers as facts. Each one is held here to its source,
// so a catalog refresh that moves one fails until home-facts.ts follows.
const images = import.meta.glob("../../website/public/home/*.webp", {
  query: "?url",
  import: "default",
  eager: true,
});
const has = (name: string) =>
  Object.keys(images).some((path) => path.endsWith(`/public/home/${name}.webp`));

type Model = (typeof snapshot.models)[number] & {
  credits?: number;
  usdPerMinute?: number;
  usdPerSecond?: number;
};
const model = (id: string) => snapshot.models.find((entry) => entry.id === id) as Model;

afterEach(() => setWebsiteLocale("en"));

describe("the home page's facts", () => {
  it("quotes the catalog it was written against", () => {
    expect(PRICES_CHECKED_AT).toBe(snapshot.checkedAt.slice(0, 10));
    expect(FAMILY_COUNT).toBe(families.length);
    expect(LANGUAGE_COUNT).toBe(SITE_LOCALES.length);
  });

  it("quotes each example price from its model, and the cheapest private one of its kind", () => {
    const hour = model(PRICE_EXAMPLES.transcriptionHour.model);
    expect(PRICE_EXAMPLES.transcriptionHour.usd).toBeCloseTo((hour.usdPerMinute ?? 0) * 60, 3);
    const image = model(PRICE_EXAMPLES.image.model);
    expect(PRICE_EXAMPLES.image.usd).toBeCloseTo((image.credits ?? 0) / 100, 4);
    const clip = model(PRICE_EXAMPLES.clip.model);
    expect(PRICE_EXAMPLES.clip.usd).toBeCloseTo(
      (clip.usdPerSecond ?? 0) * PRICE_EXAMPLES.clip.seconds,
      3,
    );
    const cheapest = (type: string, price: (entry: Model) => number | undefined) =>
      Math.min(
        ...snapshot.models
          .filter((entry) => entry.type === type && entry.privacy === "private")
          .map((entry) => price(entry as Model) ?? Number.POSITIVE_INFINITY),
      );
    expect(image.credits).toBe(cheapest("image", (entry) => entry.credits));
    expect(clip.usdPerSecond).toBe(cheapest("video", (entry) => entry.usdPerSecond));
    expect(hour.usdPerMinute).toBe(cheapest("asr", (entry) => entry.usdPerMinute));
  });

  it("prices the Studio creations at their model's price", () => {
    expect(STUDIO_CREATION_CREDITS).toBe(model(STUDIO_CREATIONS_MODEL).credits);
  });

  it("ships every picture it shows, in both languages and both themes", () => {
    for (const locale of ["en", "fr"])
      for (const name of [`home-${locale}-light`, `home-${locale}-dark`, `studio-${locale}`])
        expect(has(name), name).toBe(true);
    for (const creation of STUDIO_CREATIONS) expect(has(creation.file), creation.file).toBe(true);
  });
});

describe("the home page", () => {
  it("says what the app is, shows it, and prices it, without a style attribute", () => {
    setWebsiteLocale("en");
    const html = renderToString(<App initialPath="/" />);
    expect(html).toContain("Meeting notes, chat and studio, with private AI");
    expect(html).toContain("/home/home-en-light.webp");
    expect(html).toContain('media="(prefers-color-scheme: dark)"');
    expect(html).not.toContain("product-window");
    expect(html).toContain("About 16 credits");
    expect(html).toContain("From 0.5 credits");
    expect(html).toContain("From 4.1 credits");
    expect(html).toContain(`${FAMILY_COUNT} model families`);
    expect(html).toMatch(/<img[^>]+width="1600"[^>]+height="1000"/);
    expect(html).not.toMatch(/style="/);
  });

  it("reads in French with the French captures and French numbers", () => {
    setWebsiteLocale("fr");
    const html = renderToString(<App initialPath="/fr" />);
    expect(html).toContain("/home/home-fr-light.webp");
    expect(html).toContain("/home/studio-fr.webp");
    expect(html).toContain("Dès 0,5 crédit");
    expect(html).toContain("Faut-il un abonnement ?");
  });
});
