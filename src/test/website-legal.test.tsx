import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../website/src/App";
import { setWebsiteLocale } from "../../website/src/lib/i18n";
import { createSitePaths } from "../../website/src/lib/paths";

afterEach(() => setWebsiteLocale("en"));

describe("the legal notice", () => {
  it("names the publisher, its address and the host", () => {
    setWebsiteLocale("en");
    const html = renderToString(<App initialPath="/legal" />);
    expect(html).toContain("Legal notice");
    for (const line of [
      "Lumen Labs",
      "c/o Expertfid &amp; audit SA",
      "Rue du Rhône 80",
      "1204 Genève",
    ])
      expect(html).toContain(line);
    expect(html).toContain("Hetzner Online GmbH");
    expect(html).toContain('href="mailto:info@lumen-labs.ch"');
    expect(html).not.toMatch(/style="/);
  });

  it("reads in French on its own route, and is linked from every footer", () => {
    setWebsiteLocale("fr");
    const html = renderToString(<App initialPath="/fr/legal" />);
    expect(html).toContain("Mentions légales");
    expect(html).toContain("Suisse");
    const home = renderToString(<App initialPath="/fr" />);
    expect(home).toContain('/fr/legal"');
  });

  it("is a public page the site handles itself, in every language", () => {
    const site = createSitePaths("/subrosa/", "https://accounts.example");
    for (const path of ["/subrosa/legal", "/subrosa/fr/legal", "/subrosa/de/legal"])
      expect(
        site.handles(new URL(path, "https://marketing.example"), "https://marketing.example"),
      ).toBe(true);
  });

  it("names the operator on the privacy page instead of announcing one", () => {
    setWebsiteLocale("en");
    const html = renderToString(<App initialPath="/privacy" />);
    expect(html).toContain("Lumen Labs, in Geneva, Switzerland");
    expect(html).not.toContain("Operator details");
  });
});
