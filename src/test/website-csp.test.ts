// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARPE_DIEM_OPERATOR } from "../../website/src/lib/browser-device";
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { createHash } from "node:crypto";
import { addIntegrity } from "../../website/sri";

/** Every place the site's Content-Security-Policy is written. They must agree:
 * the static host, the account vhost, the marketing vhost and the Caddy
 * example each serve the same pages. */
const SOURCES = [
  "website/public/_headers",
  "subrosa-cloud/deploy/nginx-account.conf.example",
  "subrosa-cloud/deploy/nginx-marketing.conf",
  "subrosa-cloud/deploy/Caddyfile.example",
];

function policy(file: string): Map<string, string> {
  const text = readFileSync(file, "utf8") as string;
  const line = /Content-Security-Policy:?\s+"?([^"\n]+)"?/.exec(text)?.[1] ?? "";
  return new Map(
    line
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...values] = directive.split(/\s+/);
        return [name, values.join(" ")] as const;
      }),
  );
}

describe("the website content security policy", () => {
  it("lets the page reach its own origin and the Carpe Diem operator, nothing else", () => {
    const operator = new URL(CARPE_DIEM_OPERATOR).origin;
    for (const file of SOURCES) {
      const csp = policy(file);
      expect(csp.get("connect-src"), file).toBe(`'self' ${operator}`);
      expect(csp.get("script-src"), file).toBe("'self'");
      expect(csp.get("default-src"), file).toBe("'self'");
    }
  });

  it("refuses string script sinks everywhere, so injected markup cannot run", () => {
    for (const file of SOURCES) {
      const csp = policy(file);
      expect(csp.get("require-trusted-types-for"), file).toBe("'script'");
      expect(csp.get("trusted-types"), file).toBe("subrosa");
      expect(csp.get("object-src"), file).toBe("'none'");
      expect(csp.get("base-uri"), file).toBe("'none'");
      expect(csp.get("frame-ancestors"), file).toBe("'none'");
    }
  });

  it("is the same policy in every place that serves the site", () => {
    const [first, ...rest] = SOURCES.map((file) => {
      const csp = policy(file);
      // The Caddy example leaves fonts to default-src, which says the same.
      csp.delete("font-src");
      return [...csp.entries()].sort();
    });
    for (const other of rest) expect(other).toEqual(first);
  });
});

describe("subresource integrity on the built page", () => {
  const files: Record<string, string> = {
    "assets/index-abc.js": "console.log(1)",
    "assets/index-abc.css": "body{}",
  };
  // What the build plugin computes, from the bytes.
  const read = (name: string) =>
    files[name] === undefined
      ? undefined
      : `sha384-${createHash("sha384").update(files[name]).digest("base64")}`;

  it("pins the entry script and the stylesheet to their bytes", () => {
    const html = addIntegrity(
      `<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-abc.css">
<link rel="icon" href="/rose.png">`,
      "/",
      read,
    );
    // sha384 of "console.log(1)", computed with openssl.
    expect(html).toContain(
      'src="/assets/index-abc.js" integrity="sha384-vuz+yO71bcb30P4dMUNzy6/D2y+6d/n0KcOnt5clJtTBxEDoKAqGay0stFlC8Dpr"',
    );
    expect(html).toMatch(/href="\/assets\/index-abc.css" integrity="sha384-[A-Za-z0-9+/=]{64}"/);
    expect(html).toContain('<link rel="icon" href="/rose.png">');
  });

  it("leaves foreign and unknown files alone, and honours a base path", () => {
    expect(
      addIntegrity('<script src="https://cdn.example/x.js"></script>', "/", read),
    ).not.toContain("integrity");
    expect(addIntegrity('<script src="/assets/missing.js"></script>', "/", read)).not.toContain(
      "integrity",
    );
    expect(
      addIntegrity(
        '<script type="module" src="/subrosa/assets/index-abc.js"></script>',
        "/subrosa/",
        read,
      ),
    ).toContain("integrity=");
  });
});
