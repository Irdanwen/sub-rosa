// A headless smoke of the built task panes (ADR-0102), outside Office.
//
//   pnpm build:website                       # the site, then the panes
//   PLAYWRIGHT_CORE=<path to playwright-core> \
//   CHROMIUM=<path to a Chromium or headless shell> \
//   node office-addins/scripts/smoke.mjs [--real-office-js]
//
// Serves website/dist with the /office/ policy of website/public/_headers and
// opens each page in Chromium. By default Office.js is replaced by a stub that
// says it is Word, Excel or PowerPoint in French with an empty document; with
// --real-office-js the page loads Microsoft's library from its CDN (network)
// and must say it runs outside Office. Either way the page must render, raise
// no error and trip no Content-Security-Policy or Trusted Types violation but
// one: Office.js frames its telemetry service, which the policy refuses on
// purpose (ADR-0102), along with the inline style that frame carries.
// Nothing here runs inside real Office. Playwright is not a dependency of the
// repository.
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(root, "website", "dist");
const real = process.argv.includes("--real-office-js");
const core = process.env.PLAYWRIGHT_CORE;
if (!core) {
  process.stderr.write("Set PLAYWRIGHT_CORE to a playwright-core install.\n");
  process.exit(2);
}
const executablePath =
  process.env.CHROMIUM ??
  join(
    homedir(),
    "Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  );

const headers = readFileSync(join(root, "website/public/_headers"), "utf8");
const policy = /^\/office\/\*\n(?:.*\n)*?\s+Content-Security-Policy: ([^\n]+)/m.exec(headers)?.[1];
if (!policy) throw new Error("No /office/ policy in website/public/_headers.");

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
  if (path.startsWith("/api/")) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "unauthorized" } }));
    return;
  }
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }
  const head = { "content-type": TYPES[extname(file)] ?? "application/octet-stream" };
  if (path.startsWith("/office/")) head["content-security-policy"] = policy;
  response.writeHead(200, head);
  response.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/** Office.js as a pane sees it inside a host, with an empty document. */
const stub = (host) => `
window.Office = {
  onReady: () => Promise.resolve({ host: ${JSON.stringify(host)}, platform: "OfficeOnline" }),
  context: {
    displayLanguage: "fr-FR",
    requirements: { isSetSupported: () => true },
    ui: {
      displayDialogAsync: (url, options, callback) => callback({ status: "failed", value: null }),
      messageParent: () => undefined,
      addHandlerAsync: (type, handler, done) => done && done({ status: "succeeded" }),
    },
  },
  EventType: { DialogMessageReceived: "a", DialogEventReceived: "b", DialogParentMessageReceived: "c" },
};
`;

const { chromium } = await import(pathToFileURL(join(core, "index.mjs")).href);
const browser = await chromium.launch({ executablePath });
const pages = [
  ["word", "Word", real ? /Open this page from Word/ : /Relier Sub Rosa/],
  ["excel", "Excel", real ? /Open this page from Word/ : /Relier Sub Rosa/],
  ["powerpoint", "PowerPoint", real ? /Open this page from Word/ : /Relier Sub Rosa/],
  ["session", "Word", real ? null : /Se connecter/],
];
/** What the policy refuses on purpose: Office.js's telemetry frame. */
const REFUSED_ON_PURPOSE = [
  /frame-src https:\/\/telemetryservice\.firstpartyapps\.oaspapps\.com/,
  /Framing 'https:\/\/telemetryservice\.firstpartyapps\.oaspapps\.com\/'/,
  /style-src-attr inline/,
  /Applying inline style violates/,
];
let failures = 0;
try {
  for (const [name, host, expected] of pages) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 340, height: 640 });
    const problems = [];
    const refused = new Set();
    page.on("pageerror", (error) => problems.push(`error: ${error.message}`));
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() !== "error" || !/Content Security Policy|Trusted Type/i.test(text)) return;
      if (real && REFUSED_ON_PURPOSE.some((pattern) => pattern.test(text)))
        refused.add(text.split("\n")[0].slice(0, 110));
      else problems.push(`console: ${text}`);
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        // biome-ignore lint/suspicious/noConsole: runs in the page, read back through its console.
        console.error(
          `Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`,
        );
      });
    });
    if (!real)
      await page.route("https://appsforoffice.microsoft.com/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/javascript", body: stub(host) }),
      );
    await page.goto(`${origin}/office/${name}.html`);
    if (expected) await page.getByText(expected).first().waitFor({ timeout: 10_000 });
    else await page.waitForTimeout(3000);
    // Office.js loads its telemetry a few seconds in.
    await page.waitForTimeout(real ? 6000 : 500);
    if (process.env.SMOKE_SHOTS)
      await page.screenshot({ path: join(process.env.SMOKE_SHOTS, `${name}.png`), fullPage: true });
    const ok = problems.length === 0;
    if (!ok) failures++;
    process.stdout.write(
      `${ok ? "ok" : "FAIL"} /office/${name}.html${ok ? "" : `\n  ${problems.join("\n  ")}`}\n`,
    );
    for (const text of refused) process.stdout.write(`  refused on purpose: ${text}\n`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failures ? 1 : 0);
