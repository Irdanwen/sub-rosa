// A headless smoke of the Office add-ins on their two origins (ADR-0102 and
// its addendum of 2026-10-10), outside Office.
//
//   PLAYWRIGHT_CORE=<path to playwright-core> \
//   CHROMIUM=<path to a Chromium or headless shell> \
//   node office-addins/scripts/smoke.mjs [--real-office-js] [--no-build]
//
// It builds the site and the panes into a temporary folder for two local
// origins that are the same site, like production's:
//   account  http://subrosa.furetier.test:47801
//   office   http://office.subrosa.furetier.test:47802
// (Chromium resolves *.test to 127.0.0.1), serves each with the exact headers
// of its `_headers` file (website/public, office-addins/public), the
// production hosts swapped for these, and a stand-in for the account service
// (/api/v1/me, /api/v1/devices, /auth/login) on the account origin.
//
// Then, with Office.js replaced by a stub:
// - each pane renders on the office origin and asks the service nothing;
// - the sign-in window frames the account's courier, which says signed out;
//   "Sign in" goes to the account origin, which returns to
//   /office/signed-in.html, which hands the window back to the office
//   origin; the courier then says who is signed in, and a call the pane sends
//   through Office's channel is carried with the account's cookie and CSRF
//   token, while a call outside the seven is refused;
// - the office origin never receives the account's cookie;
// - another site cannot frame the courier;
// - the account origin's old pane addresses lead to the "moved" page.
// No page may raise an error or trip a Content-Security-Policy or Trusted
// Types violation. With --real-office-js the panes load Microsoft's library
// from its CDN (network) and must say they run outside Office, with only the
// telemetry frame the policy refuses on purpose. Nothing here runs inside
// real Office. Playwright is not a dependency of the repository.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
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

const ACCOUNT_PORT = 47801;
const OFFICE_PORT = 47802;
const OTHER_PORT = 47803;
const ACCOUNT = `http://subrosa.furetier.test:${ACCOUNT_PORT}`;
const OFFICE = `http://office.subrosa.furetier.test:${OFFICE_PORT}`;
const OTHER = `http://elsewhere.test:${OTHER_PORT}`;
/** The production origins the headers name, and what stands in for them. */
const swap = (text) =>
  text
    .replaceAll("https://office.subrosa.furetier.com", OFFICE)
    .replaceAll("https://subrosa.furetier.com", ACCOUNT);

// ── Builds ──────────────────────────────────────────────────────────────────

const out = process.argv.includes("--no-build")
  ? process.env.SMOKE_DIR
  : mkdtempSync(join(tmpdir(), "subrosa-office-smoke-"));
if (!out) {
  process.stderr.write("--no-build needs SMOKE_DIR, a folder an earlier run built.\n");
  process.exit(2);
}
const accountDist = join(out, "account");
const officeDist = join(out, "office");
if (!process.argv.includes("--no-build")) {
  const env = {
    ...process.env,
    SUBROSA_PYODIDE: "0",
    VITE_ACCOUNT_ORIGIN: ACCOUNT,
    VITE_OFFICE_ORIGIN: OFFICE,
  };
  // The account website is built without VITE_ACCOUNT_ORIGIN, as in production.
  const { VITE_ACCOUNT_ORIGIN: _, ...accountEnv } = env;
  for (const [cwd, dist, buildEnv] of [
    [join(root, "website"), accountDist, accountEnv],
    [join(root, "office-addins"), officeDist, env],
  ]) {
    const result = spawnSync(
      "pnpm",
      ["exec", "vite", "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"],
      { cwd, env: buildEnv, stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

// ── Headers, as a static host applies `_headers` ────────────────────────────

/** `_headers` rules in order: a path (exact, or ending in `*`), the headers it
 * sets and the ones it detaches (`! Name`). */
function rules(file) {
  const list = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) list.push({ path: line.trim(), set: [], detach: [] });
    else if (line.trim().startsWith("! ")) list.at(-1).detach.push(line.trim().slice(2));
    else {
      const at = line.indexOf(":");
      list.at(-1).set.push([line.slice(0, at).trim(), swap(line.slice(at + 1).trim())]);
    }
  }
  return list;
}
function headersFor(list, path) {
  const headers = new Map();
  for (const rule of list) {
    const match = rule.path.endsWith("*")
      ? path.startsWith(rule.path.slice(0, -1))
      : path === rule.path;
    if (!match) continue;
    for (const name of rule.detach) headers.delete(name.toLowerCase());
    for (const [name, value] of rule.set) headers.set(name.toLowerCase(), value);
  }
  // Plain HTTP here: HSTS would mean nothing.
  headers.delete("strict-transport-security");
  return Object.fromEntries(headers);
}
const accountRules = rules(join(root, "website/public/_headers"));
const officeRules = rules(join(root, "office-addins/public/_headers"));
const redirects = readFileSync(join(root, "website/public/_redirects"), "utf8")
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .filter((parts) => parts.length === 3 && parts[2] !== "200");

// ── Servers ─────────────────────────────────────────────────────────────────

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
function serveFile(dist, list, path, response) {
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    ...headersFor(list, path),
  });
  response.end(readFileSync(file));
}
const cookies = (header = "") =>
  Object.fromEntries(header.split(/;\s*/).map((pair) => pair.split("=")));

/** What each origin was asked, with the cookie it was sent. */
const seen = { account: [], office: [] };
const SESSION = "smoke-session";
const CSRF = "smoke-csrf";
const ME = { id: "0191d1a4-0000-7000-8000-000000000000", email: "smoke@example.test" };

const account = createServer((request, response) => {
  const url = new URL(request.url ?? "/", ACCOUNT);
  seen.account.push({
    path: url.pathname,
    cookie: request.headers.cookie ?? "",
    csrf: request.headers["x-csrf-token"],
    origin: request.headers.origin,
  });
  const jar = cookies(request.headers.cookie);
  const signedIn = jar.subrosa_session === SESSION;
  const reply = (status, body) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/auth/login") {
    // The service's allowlist (subrosa-cloud/crates/services/src/lib.rs).
    if (url.searchParams.get("return_to") !== "/office/signed-in.html")
      return reply(400, { error: { code: "invalid_request" } });
    response.writeHead(302, {
      location: "/office/signed-in.html",
      "set-cookie": [
        `subrosa_session=${SESSION}; Path=/; HttpOnly; SameSite=Lax`,
        `subrosa_csrf=${CSRF}; Path=/; SameSite=Lax`,
      ],
    });
    return response.end();
  }
  if (url.pathname === "/api/v1/me")
    return signedIn
      ? reply(200, { data: { ...ME, created_at: "" } })
      : reply(401, { error: { code: "unauthorized" } });
  if (url.pathname === "/api/v1/devices")
    return signedIn && request.headers["x-csrf-token"] === CSRF
      ? reply(200, { data: [{ id: "smoke-device", name: "Sub Rosa app" }] })
      : reply(401, { error: { code: "unauthorized" } });
  // A write, which the service guards with the exact Origin and the CSRF token.
  if (url.pathname === "/api/v1/pairing" && request.method === "POST")
    return signedIn &&
      request.headers["x-csrf-token"] === CSRF &&
      request.headers.origin === ACCOUNT
      ? reply(201, { data: { request_id: "smoke-pairing" } })
      : reply(403, { error: { code: "csrf" } });
  if (url.pathname.startsWith("/api/")) return reply(404, { error: { code: "not_found" } });
  const moved = redirects.find(([from]) => from === url.pathname);
  if (moved) {
    response.writeHead(Number(moved[2]), { location: moved[1] });
    return response.end();
  }
  serveFile(accountDist, accountRules, url.pathname, response);
});
const office = createServer((request, response) => {
  const url = new URL(request.url ?? "/", OFFICE);
  seen.office.push({ path: url.pathname, cookie: request.headers.cookie ?? "" });
  serveFile(officeDist, officeRules, url.pathname, response);
});
/** Another site, which tries to frame the courier. */
const other = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><iframe src="${ACCOUNT}/office/courier.html"></iframe>`);
});
await Promise.all(
  [
    [account, ACCOUNT_PORT],
    [office, OFFICE_PORT],
    [other, OTHER_PORT],
  ].map(([server, port]) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve))),
);

// ── Browser ─────────────────────────────────────────────────────────────────

/** Office.js as a pane or the sign-in window sees it inside a host. */
const stub = (host, language) => `
window.__toPane = [];
window.Office = {
  onReady: () => Promise.resolve({ host: ${JSON.stringify(host)}, platform: "OfficeOnline" }),
  context: {
    displayLanguage: ${JSON.stringify(language)},
    requirements: { isSetSupported: () => true },
    ui: {
      displayDialogAsync: (url, options, callback) => callback({ status: "failed", value: null }),
      messageParent: (message) => window.__toPane.push(JSON.parse(message)),
      addHandlerAsync: (type, handler, done) => {
        window.__fromPane = handler;
        if (done) done({ status: "succeeded" });
      },
    },
  },
  EventType: { DialogMessageReceived: "a", DialogEventReceived: "b", DialogParentMessageReceived: "c" },
};
`;
/** What the policy refuses on purpose: Office.js's telemetry frame. */
const REFUSED_ON_PURPOSE = [
  /frame-src https:\/\/telemetryservice\.firstpartyapps\.oaspapps\.com/,
  /Framing 'https:\/\/telemetryservice\.firstpartyapps\.oaspapps\.com\/'/,
  /style-src-attr inline/,
  /Applying inline style violates/,
];

const { chromium } = await import(pathToFileURL(join(core, "index.mjs")).href);
const browser = await chromium.launch({
  executablePath,
  args: ["--host-resolver-rules=MAP *.test 127.0.0.1"],
});

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures++;
  process.stdout.write(`${ok ? "ok" : "FAIL"} ${label}${ok || !detail ? "" : `\n  ${detail}`}\n`);
};

async function open(host, language = "fr-FR") {
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
      route.fulfill({ status: 200, contentType: "text/javascript", body: stub(host, language) }),
    );
  return { context, page, problems, refused };
}

try {
  // Each pane renders on the office origin and asks the account nothing.
  for (const [name, host] of [
    ["word", "Word"],
    ["excel", "Excel"],
    ["powerpoint", "PowerPoint"],
  ]) {
    const { context, page, problems, refused } = await open(host);
    await page.goto(`${OFFICE}/office/${name}.html`);
    await page
      .getByText(real ? /Open this page from Word/ : /Relier Sub Rosa/)
      .first()
      .waitFor({ timeout: 10_000 });
    await page.waitForTimeout(real ? 6000 : 500);
    if (process.env.SMOKE_SHOTS)
      await page.screenshot({ path: join(process.env.SMOKE_SHOTS, `${name}.png`), fullPage: true });
    check(problems.length === 0, `${OFFICE}/office/${name}.html renders`, problems.join("\n  "));
    for (const text of refused) process.stdout.write(`  refused on purpose: ${text}\n`);
    await context.close();
  }
  check(
    !seen.office.some((request) => request.path.startsWith("/api/")) &&
      !seen.account.some((request) => request.path.startsWith("/api/")),
    "the panes call no account API, on either origin",
  );

  if (!real) {
    // The sign-in loop: window → courier → sign-in → signed-in → window.
    const { context, page, problems } = await open("Word", "en-US");
    await page.goto(`${OFFICE}/office/session.html`);
    await page.getByText(/Sign in to your Sub Rosa account/).waitFor({ timeout: 10_000 });
    const before = await page.evaluate(() => window.__toPane);
    check(
      JSON.stringify(before) === JSON.stringify([{ v: 1, type: "signed-out" }]),
      "the courier says signed out before sign-in",
      JSON.stringify(before),
    );
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText(`Signed in as ${ME.email}`).waitFor({ timeout: 10_000 });
    check(
      page.url() === `${OFFICE}/office/session.html`,
      "sign-in returns to the window",
      page.url(),
    );
    const ready = await page.evaluate(() => window.__toPane);
    check(
      ready[0]?.type === "ready" && ready[0].account.email === ME.email,
      "the courier says who is signed in, through the window, to the pane",
      JSON.stringify(ready),
    );
    const visited = seen.account.map((request) => request.path);
    check(
      visited.includes("/auth/login") && visited.includes("/office/signed-in.html"),
      "the window signed in on the account origin and came back through signed-in.html",
    );

    // A call the pane sends through Office's channel, then one it may not.
    const send = (message) =>
      page.evaluate(
        ([text, origin]) => window.__fromPane({ message: text, origin }),
        [JSON.stringify(message), OFFICE],
      );
    await send({
      v: 1,
      type: "request",
      id: "q1",
      method: "GET",
      path: "/api/v1/devices",
      headers: {},
    });
    await send({
      v: 1,
      type: "request",
      id: "q2",
      method: "GET",
      path: "/api/v1/vault",
      headers: {},
    });
    await send({
      v: 1,
      type: "request",
      id: "q3",
      method: "POST",
      path: "/api/v1/pairing",
      headers: {},
      body: "{}",
    });
    await page.waitForFunction(() => window.__toPane.length >= 4, null, { timeout: 10_000 });
    const answers = await page.evaluate(() => window.__toPane.slice(1));
    const q1 = answers.find((answer) => answer.id === "q1");
    const q2 = answers.find((answer) => answer.id === "q2");
    check(
      q1?.status === 200 && q1.body.includes("smoke-device"),
      "the courier carries an allowed call",
      JSON.stringify(q1),
    );
    check(q2?.status === 403, "the courier refuses a call outside the seven", JSON.stringify(q2));
    const q3 = answers.find((answer) => answer.id === "q3");
    const pairing = seen.account.find((request) => request.path === "/api/v1/pairing");
    check(
      q3?.status === 201 &&
        pairing?.csrf === CSRF &&
        pairing.origin === ACCOUNT &&
        pairing.cookie.includes(`subrosa_session=${SESSION}`),
      "a carried write has the account's cookie, CSRF token and exact origin",
      JSON.stringify({ q3, pairing }),
    );
    check(
      !seen.account.some((request) => request.path === "/api/v1/vault"),
      "the refused call never reached the service",
    );
    check(
      problems.length === 0,
      "the sign-in loop raises no error or violation",
      problems.join("\n  "),
    );
    await context.close();

    // Another site cannot frame the courier.
    const framer = await open("Word");
    const blocked = [];
    framer.page.on("console", (message) => {
      if (/frame-ancestors/.test(message.text())) blocked.push(message.text());
    });
    await framer.page.goto(`${OTHER}/`);
    await framer.page.waitForTimeout(1000);
    check(blocked.length > 0, "another site cannot frame the courier");
    await framer.context.close();

    // The account origin's old pane addresses say where the add-ins went.
    const old = await open("Word");
    await old.page.goto(`${ACCOUNT}/office/word.html`);
    await old.page.getByText("Sub Rosa for Office has moved").waitFor({ timeout: 10_000 });
    check(
      old.page.url() === `${ACCOUNT}/office/moved.html` && old.problems.length === 0,
      "the old pane address leads to the moved page",
      old.problems.join("\n  "),
    );
    await old.context.close();
  }

  const leaked = seen.office.filter((request) => /subrosa_(session|csrf)/.test(request.cookie));
  check(
    seen.office.length > 0 && leaked.length === 0,
    "the office origin never receives the account's cookie",
    leaked.map((request) => request.path).join(", "),
  );
} finally {
  await browser.close();
  for (const server of [account, office, other]) server.close();
  if (!process.argv.includes("--no-build") && !process.env.SMOKE_KEEP)
    rmSync(out, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
