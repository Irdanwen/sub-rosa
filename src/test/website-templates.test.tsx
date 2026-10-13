import { act, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../website/src/App";
import { setWebsiteLocale } from "../../website/src/lib/i18n";
import { useActiveSection } from "../../website/src/lib/section-spy";

afterEach(() => setWebsiteLocale("en"));

describe("the site's page templates (S4)", () => {
  it("joins privacy, security and the legal notice, and marks the page being read", () => {
    setWebsiteLocale("en");
    for (const path of ["/privacy", "/security", "/legal"]) {
      const html = renderToString(<App initialPath={path} />);
      expect(html).toContain('class="trust-nav"');
      expect(html).toMatch(new RegExp(`href="[^"]*${path}"[^>]*aria-current="page"`));
    }
  });

  it("shows the Studio guide's capture in the reader's language, with its size", () => {
    setWebsiteLocale("fr");
    const french = renderToString(<App initialPath="/fr/docs/studio-media" />);
    expect(french).toContain("/home/studio-fr.webp");
    expect(french).toMatch(/<img[^>]+width="1600"[^>]+height="1000"/);
    setWebsiteLocale("de");
    const german = renderToString(<App initialPath="/de/docs/studio-media" />);
    expect(german).toContain("/home/studio-en.webp");
  });

  it("aligns download buttons by giving every card the same description room", () => {
    setWebsiteLocale("en");
    const html = renderToString(<App initialPath="/downloads" />);
    expect(html).toContain("download-card");
    expect(html).not.toContain("TestFlight access");
  });
});

describe("the section being read", () => {
  it("marks the first section in the reading band, in document order", () => {
    let report: (entries: Partial<IntersectionObserverEntry>[]) => void = () => undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
          report = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    document.body.innerHTML = '<section id="a"></section><section id="b"></section>';
    const seen: (string | undefined)[] = [];
    function Probe() {
      seen.push(useActiveSection(["a", "b"]));
      return null;
    }
    render(<Probe />);
    const a = document.getElementById("a") as Element;
    const b = document.getElementById("b") as Element;
    act(() => report([{ target: b, isIntersecting: true }]));
    expect(seen.at(-1)).toBe("b");
    act(() => report([{ target: a, isIntersecting: true }]));
    expect(seen.at(-1)).toBe("a");
    vi.unstubAllGlobals();
  });
});
