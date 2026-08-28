// The CSP is one long string in a config file, it ships in the binary, and
// nothing type-checks it. These assertions are the only thing standing between
// a plausible-looking edit and a platform where the gallery renders nothing.

import { describe, expect, it } from "vitest";
// Imported rather than read off disk: no Node types in this project's
// tsconfig, and the bundler resolves it the same way the build does.
import config from "../../src-tauri/tauri.conf.json";

const csp: string = config.app.security.csp;

/** The source list of one directive, or undefined when it is not declared. */
function directive(name: string): string[] | undefined {
  const found = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found?.split(/\s+/).slice(1);
}

describe("asset protocol CSP", () => {
  // `convertFileSrc` does not answer the same URL everywhere: `asset://localhost/…`
  // on macOS and Linux, `http://asset.localhost/…` on Windows and Android
  // (WebView2 and the Android webview cannot register a custom scheme). A CSP
  // carrying only `asset:` therefore passes every check a Mac can run and
  // blocks every gallery image and clip on Windows - which is exactly what it
  // did, silently, since the directives were first written.
  for (const name of ["img-src", "media-src"]) {
    it(`lets ${name} load assets on every platform, not just the one it was written on`, () => {
      const sources = directive(name);
      expect(sources).toBeDefined();
      expect(sources).toContain("asset:");
      expect(sources).toContain("http://asset.localhost");
    });
  }

  // `https:` was in both directives for one reason: the remote film studio
  // served its thumbnails and clips from signed URLs. That studio is gone
  // (ADR-0029), every remaining loader goes through `asset:`, `data:` or the
  // gallery, and a wildcard remote origin in a local-first app is exactly the
  // kind of thing that survives because nobody remembers what put it there.
  for (const name of ["img-src", "media-src"]) {
    it(`does not let ${name} reach an arbitrary remote origin`, () => {
      expect(directive(name)).not.toContain("https:");
      expect(directive(name)).not.toContain("*");
    });
  }

  it("keeps the asset protocol enabled and scoped to what the app writes", () => {
    const { enable, scope } = config.app.security.assetProtocol;
    expect(enable).toBe(true);
    // The gallery directory, wherever the platform puts it. A scope that stops
    // matching is the other way these tiles go blank.
    expect(scope).toContain("$APPDATA/studio-media/*");
  });

  // Every media element in the mobile shell is fed an object URL, and three
  // separate modules say so in their own comments: WKWebView's media loader
  // byte-range-requests its source and a `data:` URL cannot answer one. The
  // directive still listed only `data:`, so the webview refused every blob it
  // was handed - clips would not play, posters decoded to nothing, and a note
  // would not read itself aloud. The file it all lands in is the gallery, and
  // the failure is silent in all three places.
  it("lets media-src load the object URLs iOS requires", () => {
    expect(directive("media-src")).toContain("blob:");
  });

  it("declares every directive the loaders in this app actually need", () => {
    // Anything not listed here falls back to `default-src`, which is `'self'` -
    // and `'self'` matches none of the schemes below.
    expect(directive("img-src")).toEqual(expect.arrayContaining(["data:"]));
    expect(directive("media-src")).toEqual(expect.arrayContaining(["data:"]));
    // The sidecar answers on a loopback port picked at launch, over both HTTP
    // and a websocket for the agent gateway.
    expect(directive("connect-src")).toEqual(
      expect.arrayContaining(["http://127.0.0.1:*", "ws://127.0.0.1:*"]),
    );
  });
});
