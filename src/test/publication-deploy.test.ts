// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The public pages origin (ADR-0097) is apart from the account origin and
 * proxies only what is public. These are the deployment files that say so. */
const nginx = readFileSync("subrosa-cloud/deploy/nginx-pages.conf.example", "utf8") as string;
const caddy = readFileSync("subrosa-cloud/deploy/Caddyfile.example", "utf8") as string;
const account = readFileSync("subrosa-cloud/deploy/nginx-account.conf.example", "utf8") as string;

describe("the public pages origin", () => {
  it("sends only the public prefixes to the service, and nothing of the account", () => {
    const proxied = [...nginx.matchAll(/location\s+(\^~\s+)?(\S+)\s*\{[^}]*proxy_pass/g)].map(
      (match) => match[2],
    );
    expect(proxied.sort()).toEqual(["/_pub/", "/p/", "/u/"]);
    for (const forbidden of ["/api", "/auth", "/id/", "try_files $uri $uri/ /index.html"])
      expect(nginx).not.toContain(forbidden);
    expect(nginx).toMatch(/location \/ \{ return 404; \}/);
    // The service writes each page's policy; the proxy never loosens it.
    expect(nginx).not.toMatch(/add_header\s+Content-Security-Policy/);
    expect(nginx).toContain('proxy_set_header Cookie "";');
    const block = caddy.slice(caddy.indexOf("pages.example.invalid {"));
    expect(block).toContain("@public path /p/* /u/* /_pub/*");
    expect(block).toContain("request_header -Cookie");
    expect(block).not.toContain("/api/*");
  });

  it("is never served from the account origin", () => {
    expect(account).not.toMatch(/location\s+(\^~\s+)?\/(p|u|_pub)\//);
  });
});
