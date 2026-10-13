import { describe, expect, it } from "vitest";
import { alternateLinks, shareTags, siteOrigin, sitemap } from "../../website/src/lib/alternates";

const hrefs = (html: string) =>
  [...html.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map(([, lang, href]) => [lang, href]);

describe("prerendered hreflang alternates", () => {
  it("are absolute URLs on the public site under /subrosa/", () => {
    const links = hrefs(alternateLinks("/downloads", "/subrosa/", siteOrigin("/subrosa/")));
    expect(links).toEqual([
      ["en", "https://furetier.com/subrosa/downloads"],
      ["fr", "https://furetier.com/subrosa/fr/downloads"],
      ["de", "https://furetier.com/subrosa/de/downloads"],
      ["it", "https://furetier.com/subrosa/it/downloads"],
      ["es", "https://furetier.com/subrosa/es/downloads"],
      ["pt-BR", "https://furetier.com/subrosa/pt-br/downloads"],
      ["x-default", "https://furetier.com/subrosa/downloads"],
    ]);
  });

  it("are absolute URLs on the account website at its root", () => {
    const links = hrefs(alternateLinks("/", "/", siteOrigin("/")));
    expect(links[0]).toEqual(["en", "https://subrosa.furetier.com/"]);
    expect(links[1]).toEqual(["fr", "https://subrosa.furetier.com/fr/"]);
    expect(links.at(-1)).toEqual(["x-default", "https://subrosa.furetier.com/"]);
    for (const [, href] of links) expect(new URL(href).href).toBe(href);
  });

  it("takes a configured origin and refuses anything but a bare HTTPS origin", () => {
    expect(siteOrigin("/docs-site/", "https://example.org")).toBe("https://example.org");
    expect(() => siteOrigin("/docs-site/")).toThrow(/VITE_SITE_ORIGIN/);
    expect(() => siteOrigin("/", "http://example.org")).toThrow(/HTTPS origin/);
    expect(() => siteOrigin("/", "https://example.org/path")).toThrow(/HTTPS origin/);
  });
});

describe("what a shared link of a public page shows", () => {
  it("names the page, its words and the Studio picture, at this language's address", () => {
    const tags = shareTags({
      page: "/downloads",
      locale: "fr",
      base: "/subrosa/",
      origin: siteOrigin("/subrosa/"),
      title: "Télécharger · Sub Rosa",
      description: "L’app pour Mac, Windows & Android",
    });
    expect(tags).toContain(
      '<link rel="canonical" href="https://furetier.com/subrosa/fr/downloads" />',
    );
    expect(tags).toContain('<meta property="og:title" content="Télécharger · Sub Rosa" />');
    expect(tags).toContain("Mac, Windows &amp; Android");
    expect(tags).toContain(
      '<meta property="og:image" content="https://furetier.com/subrosa/share-fr.jpg" />',
    );
    expect(tags).toContain('<meta property="og:image:width" content="1200" />');
    expect(tags).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it("lists every page in every language in the sitemap", () => {
    const xml = sitemap(["/", "/downloads"], "/", siteOrigin("/"));
    expect(xml).toContain("<loc>https://subrosa.furetier.com/fr/downloads</loc>");
    expect(xml.match(/<url>/g)).toHaveLength(12);
  });
});
