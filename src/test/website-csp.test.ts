// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARPE_DIEM_OPERATOR } from "../../website/src/lib/browser-device";
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { createHash } from "node:crypto";
import { addIntegrity } from "../../website/sri";
import { webConnectOrigins } from "../../website/src/client/connectors/words";

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

/** The places that serve `/app` (the marketing vhost serves no web client),
 * each with the policy of its `/app` block. */
const APP_SOURCES: [string, RegExp][] = [
  ["website/public/_headers", /^\/app\n(?:.*\n)*?\s+Content-Security-Policy: ([^\n]+)/m],
  [
    "subrosa-cloud/deploy/nginx-account.conf.example",
    /location = \/app \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
  ],
  [
    "subrosa-cloud/deploy/Caddyfile.example",
    /header @app \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
  ],
];

function directives(line: string): Map<string, string> {
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

describe("the web client's own policy on /app", () => {
  const operator = new URL(CARPE_DIEM_OPERATOR).origin;
  const app = APP_SOURCES.map(([file, pattern]) => {
    const line = pattern.exec(readFileSync(file, "utf8") as string)?.[1] ?? "";
    return [file, directives(line)] as const;
  });

  it("adds only WebAssembly, the frames and the catalog's connectors", () => {
    const connectors = webConnectOrigins().join(" ");
    for (const [file, csp] of app) {
      expect(csp.get("script-src"), file).toBe("'self' 'wasm-unsafe-eval'");
      // Python's worker lives in the sandbox frame now, never on the page.
      expect(csp.get("worker-src"), file).toBe("'self'");
      expect(csp.get("frame-src"), file).toBe("'self'");
      // Named origins, never a scheme: what the page may post to is a list.
      expect(csp.get("connect-src"), file).toBe(`'self' ${operator} ${connectors}`);
      expect(csp.get("connect-src"), file).not.toMatch(/(^|\s)https:(\s|$)/);
      expect(csp.get("require-trusted-types-for"), file).toBe("'script'");
      expect(csp.get("trusted-types"), file).toBe("subrosa");
      expect(csp.get("frame-ancestors"), file).toBe("'none'");
      expect(csp.has("unsafe-eval"), file).toBe(false);
      expect([...csp.values()].join(" "), file).not.toContain("'unsafe-eval'");
      expect([...csp.values()].join(" "), file).not.toContain("'unsafe-inline'");
    }
  });

  it("is otherwise the site's policy, in every place that serves it", () => {
    const site = policy("website/public/_headers");
    for (const [file, csp] of app)
      for (const [name, value] of site) {
        if (["script-src", "connect-src"].includes(name)) continue;
        if (name === "font-src" && !csp.has("font-src")) continue;
        expect(csp.get(name), `${file} ${name}`).toBe(value);
      }
  });

  it("lets /app use the microphone, the camera and the screen, and nothing else does", () => {
    for (const file of APP_SOURCES.map(([name]) => name)) {
      const text = readFileSync(file, "utf8") as string;
      expect(text, file).toContain("camera=(self), microphone=(self), display-capture=(self)");
      expect(text.match(/microphone=\(self\)/g)?.length, file).toBeLessThanOrEqual(2);
    }
    for (const file of SOURCES) expect(policy(file).get("script-src"), file).toBe("'self'");
  });

  it("serves the connector view host its own policy and lets only the site frame it", () => {
    const markers: Record<string, string> = {
      "website/public/_headers": "\n/connector-view.html\n",
      "subrosa-cloud/deploy/nginx-account.conf.example": "location = /connector-view.html",
      "subrosa-cloud/deploy/Caddyfile.example": "header @view",
    };
    for (const [file, marker] of Object.entries(markers)) {
      const text = readFileSync(file, "utf8") as string;
      const from = text.indexOf(marker);
      expect(from, file).toBeGreaterThan(0);
      const block = text.slice(from, text.indexOf("\n\n", from + 1) >>> 0);
      expect(block, file).toMatch(/default-src 'none'/);
      expect(block, file).toMatch(/frame-ancestors 'self'/);
      expect(block, file).toMatch(/SAMEORIGIN/);
      expect(block, file).not.toMatch(/unsafe-eval/);
    }
  });
});

/** The deploy examples name placeholder hosts; the static headers, the real
 * ones. Read with the real ones so every copy compares. */
const placeholders = (text: string) =>
  text
    .replaceAll("https://account.example.invalid", "https://subrosa.furetier.com")
    .replaceAll("https://office.example.invalid", "https://office.subrosa.furetier.com");
const read = (file: string) => placeholders(readFileSync(file, "utf8") as string);

/** The places that serve the Office task panes, each with its policy: their
 * own origin since the addendum of 2026-10-10 to ADR-0102. */
const OFFICE_SOURCES: [string, RegExp][] = [
  ["office-addins/public/_headers", /^\/\*\n(?:.*\n)*?\s+Content-Security-Policy: ([^\n]+)/m],
  [
    "subrosa-cloud/deploy/nginx-office.conf.example",
    /location \^~ \/office\/ \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
  ],
  [
    "subrosa-cloud/deploy/Caddyfile.example",
    /office\.example\.invalid \{[\s\S]*?header @office \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
  ],
];
const COURIER = "https://subrosa.furetier.com/office/courier.html";

describe("the Office task panes' own policy, on their own origin", () => {
  const operator = new URL(CARPE_DIEM_OPERATOR).origin;
  const office = OFFICE_SOURCES.map(([file, pattern]) => {
    const line = pattern.exec(read(file))?.[1] ?? "";
    return [file, directives(line)] as const;
  });

  it("adds Office.js from Microsoft's CDN and nothing else foreign to run", () => {
    for (const [file, csp] of office) {
      expect(csp.get("script-src"), file).toBe(
        "'self' 'wasm-unsafe-eval' https://appsforoffice.microsoft.com",
      );
      // What the pane may post to is still its own origin and the operator.
      expect(csp.get("connect-src"), file).toBe(`'self' ${operator}`);
      expect(csp.get("trusted-types"), file).toBe("subrosa officejs");
      expect(csp.get("require-trusted-types-for"), file).toBe("'script'");
      expect(csp.get("worker-src"), file).toBe("'self' blob:");
      // The pane's own origin for the Excel pane's Python sandbox, and the
      // account's courier page for the sign-in window, and only it.
      expect(csp.get("frame-src"), file).toBe(
        `'self' https://appsforoffice.microsoft.com ${COURIER}`,
      );
      expect([...csp.values()].join(" "), file).not.toContain("'unsafe-eval'");
      expect([...csp.values()].join(" "), file).not.toContain("'unsafe-inline'");
    }
  });

  it("lets only Office's own hosts frame the panes", () => {
    for (const [file, csp] of office) {
      const ancestors = (csp.get("frame-ancestors") ?? "").split(" ");
      expect(ancestors.length, file).toBeGreaterThan(0);
      for (const ancestor of ancestors)
        expect(ancestor, file).toMatch(
          /^https:\/\/(\*\.)?(officeapps\.live\.com|onedrive\.live\.com|office\.com|office365\.com|cloud\.microsoft|sharepoint\.com)$/,
        );
    }
  });

  it("is otherwise the site's policy, and the same in every place that serves it", () => {
    const site = policy("website/public/_headers");
    const [first, ...rest] = office.map(([, csp]) => [...csp.entries()].sort());
    for (const other of rest) expect(other).toEqual(first);
    for (const [file, csp] of office)
      for (const [name, value] of site) {
        if (["script-src", "frame-ancestors", "trusted-types"].includes(name)) continue;
        expect(csp.get(name), `${file} ${name}`).toBe(value);
      }
  });

  it("sends no X-Frame-Options to the panes, which would keep Office on the web out", () => {
    const nginx = read("subrosa-cloud/deploy/nginx-office.conf.example");
    const from = nginx.indexOf("location ^~ /office/");
    expect(nginx.slice(from, nginx.indexOf("}", from))).not.toContain("X-Frame-Options");
    expect(read("office-addins/public/_headers")).not.toMatch(/^\s+X-Frame-Options:/m);
    const caddy = read("subrosa-cloud/deploy/Caddyfile.example");
    const block = caddy.slice(caddy.indexOf("office.example.invalid {"));
    expect(block.slice(0, block.indexOf("@pyodide"))).not.toContain("X-Frame-Options");
  });

  it("proxies no service and passes no cookie on the office origin", () => {
    const nginx = read("subrosa-cloud/deploy/nginx-office.conf.example");
    expect(nginx).not.toMatch(/proxy_pass|\/api|\/auth/);
    const caddy = read("subrosa-cloud/deploy/Caddyfile.example");
    const block = caddy.slice(
      caddy.indexOf("office.example.invalid {"),
      caddy.indexOf("# Public pages (ADR 0097)"),
    );
    expect(block).not.toContain("reverse_proxy");
    expect(block).toContain("request_header -Cookie");
  });
});

/** The account origin's two pages for the add-ins, and the page at their
 * old addresses: none runs Office.js. */
const ACCOUNT_OFFICE: Record<string, { courier: RegExp; moved: RegExp }> = {
  "website/public/_headers": {
    courier: /^\/office\/courier\.html\n(?:.*\n)*?\s+Content-Security-Policy: ([^\n]+)/m,
    moved: /^\/office\/moved\.html\n(?:.*\n)*?\s+Content-Security-Policy: ([^\n]+)/m,
  },
  "subrosa-cloud/deploy/nginx-account.conf.example": {
    courier: /location = \/office\/courier\.html \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
    moved: /location = \/office\/moved\.html \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
  },
  "subrosa-cloud/deploy/Caddyfile.example": {
    courier: /header @courier \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
    moved: /header @moved \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
  },
};

describe("the account origin after the add-ins moved", () => {
  it("serves the courier with a policy that lets only the office origin frame it", () => {
    for (const [file, { courier }] of Object.entries(ACCOUNT_OFFICE)) {
      const line = courier.exec(read(file))?.[1];
      expect(line, file).toBe(
        "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors https://office.subrosa.furetier.com; require-trusted-types-for 'script'; trusted-types 'none'",
      );
    }
  });

  it("sends the courier no X-Frame-Options and no cache", () => {
    const headers = read("website/public/_headers");
    const rule = headers.slice(headers.indexOf("\n/office/courier.html\n"));
    const courier = rule.slice(0, rule.indexOf("\n/office/signed-in.html"));
    expect(courier).toMatch(/! X-Frame-Options/);
    expect(courier).not.toMatch(/^\s+X-Frame-Options:/m);
    expect(courier).toContain("Cache-Control: no-store");
    const nginx = read("subrosa-cloud/deploy/nginx-account.conf.example");
    const from = nginx.indexOf("location = /office/courier.html");
    const block = nginx.slice(from, nginx.indexOf("}", from));
    expect(block).not.toContain("X-Frame-Options");
    expect(block).toContain("Cache-Control no-store");
    const caddy = read("subrosa-cloud/deploy/Caddyfile.example");
    expect(caddy).toContain(
      "@site not path /app /app/* /connector-view.html /office/courier.html /office/moved.html /python-sandbox.html",
    );
  });

  it("runs no script on the page at the old addresses", () => {
    for (const [file, { moved }] of Object.entries(ACCOUNT_OFFICE)) {
      const csp = directives(moved.exec(read(file))?.[1] ?? "");
      expect(csp.get("default-src"), file).toBe("'none'");
      expect(csp.has("script-src"), file).toBe(false);
    }
  });

  it("no longer serves Office.js anywhere", () => {
    for (const file of [
      "website/public/_headers",
      "subrosa-cloud/deploy/nginx-account.conf.example",
      "subrosa-cloud/deploy/nginx-marketing.conf",
    ])
      expect(read(file), file).not.toContain("appsforoffice");
    const caddy = read("subrosa-cloud/deploy/Caddyfile.example");
    const account = caddy.slice(0, caddy.indexOf("office.example.invalid {"));
    expect(account).not.toContain("appsforoffice");
  });

  it("sends the old pane addresses to the moved page", () => {
    const redirects = read("website/public/_redirects");
    for (const page of ["word", "excel", "powerpoint", "session", "commands"])
      expect(redirects).toContain(`/office/${page}.html /office/moved.html 308`);
    expect(read("subrosa-cloud/deploy/nginx-account.conf.example")).toContain(
      "^/office/(word|excel|powerpoint|session|commands)\\.html$",
    );
  });
});

/** The places that serve a Python sandbox page (ADR-0104 addendum of
 * 2026-10-10), each with its policy: the account origin's, framed by /app,
 * and the office origin's own copy, framed by the Excel pane. */
const SANDBOX_SOURCES: Record<"account" | "office", [string, RegExp][]> = {
  account: [
    [
      "website/public/_headers",
      /^\/python-sandbox\.html\n(?:.*\n)*?\s+Content-Security-Policy: ([^\n]+)/m,
    ],
    [
      "subrosa-cloud/deploy/nginx-account.conf.example",
      /location = \/python-sandbox\.html \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
    ],
    [
      "subrosa-cloud/deploy/Caddyfile.example",
      /header @sandbox \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
    ],
  ],
  office: [
    [
      "office-addins/public/_headers",
      /^\/python-sandbox\.html\n(?:.*\n)*?\s+Content-Security-Policy: ([^\n]+)/m,
    ],
    [
      "subrosa-cloud/deploy/nginx-office.conf.example",
      /location = \/python-sandbox\.html \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
    ],
    [
      "subrosa-cloud/deploy/Caddyfile.example",
      /office\.example\.invalid \{[\s\S]*?header @sandbox \{[\s\S]*?Content-Security-Policy "([^"]+)"/,
    ],
  ],
};

describe("the Python sandbox's own policy", () => {
  const ACCOUNT = "https://subrosa.furetier.com";
  const OFFICE = "https://office.subrosa.furetier.com";
  /** Where each origin's build puts the sandbox's scripts. */
  const assets = { account: `${ACCOUNT}/assets/`, office: `${OFFICE}/office/assets/` };
  const origins = { account: ACCOUNT, office: OFFICE };
  const sandbox = (Object.keys(SANDBOX_SOURCES) as ("account" | "office")[]).flatMap((side) =>
    SANDBOX_SOURCES[side].map(([file, pattern]) => {
      // The account's static headers carry the example host, like the vhosts.
      const line = pattern.exec(read(file))?.[1] ?? "";
      return [side, file, directives(line)] as const;
    }),
  );
  const officeHosts = (OFFICE_SOURCES[0][1].exec(read(OFFICE_SOURCES[0][0]))?.[1] ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("frame-ancestors "))
    ?.slice("frame-ancestors ".length);

  it("loads its origin's sandbox scripts and Pyodide, and posts to Pyodide alone", () => {
    expect(sandbox).toHaveLength(6);
    for (const [side, file, csp] of sandbox) {
      const origin = origins[side];
      expect(csp.get("default-src"), file).toBe("'none'");
      expect(csp.get("script-src"), file).toBe(
        `${assets[side]} ${origin}/pyodide/ 'wasm-unsafe-eval'`,
      );
      // A module worker's imports are worker requests: its own chunk is one.
      expect(csp.get("worker-src"), file).toBe(`data: ${assets[side]}`);
      expect(csp.get("connect-src"), file).toBe(`${origin}/pyodide/`);
      expect(csp.get("base-uri"), file).toBe("'none'");
      expect(csp.get("form-action"), file).toBe("'none'");
      expect(csp.get("require-trusted-types-for"), file).toBe("'script'");
      expect(csp.get("trusted-types"), file).toBe("subrosa-python");
      expect([...csp.values()].join(" "), file).not.toMatch(/'unsafe-|'self'|https:(\s|$)/);
    }
  });

  it("lets only the site frame the account's, and the pane and Office's hosts the office's", () => {
    for (const [side, file, csp] of sandbox)
      expect(csp.get("frame-ancestors"), file).toBe(
        side === "account" ? ACCOUNT : `${OFFICE} ${officeHosts}`,
      );
  });

  it("is the same policy in every place that serves it on one origin", () => {
    for (const side of ["account", "office"] as const) {
      const [first, ...rest] = sandbox
        .filter(([which]) => which === side)
        .map(([, , csp]) => [...csp.entries()].sort());
      for (const other of rest) expect(other).toEqual(first);
    }
  });

  it("answers the sandbox's opaque origin with CORS on its scripts and Pyodide only", () => {
    for (const [file, scripts] of [
      ["website/public/_headers", "/assets/python-sandbox"],
      ["office-addins/public/_headers", "/office/assets/python-sandbox"],
    ]) {
      const headers = read(file);
      const escaped = scripts.replaceAll("/", "\\/");
      expect(headers, file).toMatch(
        new RegExp(`\\n${escaped}\\*\\n\\s+Access-Control-Allow-Origin: \\*\\n`),
      );
      expect(headers, file).toMatch(
        /\n\/pyodide\/\*\n(?:\s+.*\n)*?\s+Access-Control-Allow-Origin: \*(\n|$)/,
      );
      expect(headers.match(/Access-Control-Allow-Origin/g), file).toHaveLength(2);
      // The page's own rule, up to the next path: framed, so no X-Frame-Options.
      const page = headers.slice(headers.indexOf("\n/python-sandbox.html\n") + 1);
      const rule = page.split(/\n(?=\S)/)[0];
      expect(rule, file).toContain("Content-Security-Policy: default-src 'none'");
      expect(rule, file).not.toMatch(/^\s+X-Frame-Options:/m);
    }
    expect(read("website/public/_headers")).toMatch(
      /\/python-sandbox\.html\n(?:\s+!.*\n)*\s+! X-Frame-Options/,
    );
    for (const [file, scripts] of [
      ["subrosa-cloud/deploy/nginx-account.conf.example", "^~ /assets/python-sandbox"],
      ["subrosa-cloud/deploy/nginx-office.conf.example", "^~ /office/assets/python-sandbox"],
    ]) {
      const blocks = read(file).split(/\n {4}location /);
      const cors = blocks.filter((block) => block.includes("Access-Control-Allow-Origin"));
      expect(cors.map((block) => block.split(" {")[0]).sort(), file).toEqual(
        [scripts, "^~ /pyodide/"].sort(),
      );
      const page = blocks.find((block) => block.startsWith("= /python-sandbox.html")) ?? "";
      expect(page, file).toContain("Content-Security-Policy");
      expect(page, file).not.toContain("X-Frame-Options");
    }
    const caddy = read("subrosa-cloud/deploy/Caddyfile.example");
    expect(caddy).toContain("@sandboxed path /assets/python-sandbox* /pyodide/*");
    expect(caddy).toContain("@sandboxed path /office/assets/python-sandbox* /pyodide/*");
    expect(caddy.match(/Access-Control-Allow-Origin/g)).toHaveLength(2);
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
