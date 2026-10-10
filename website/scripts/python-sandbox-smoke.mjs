// A real-browser smoke of the web client's Python sandbox (ADR-0086, ADR-0104
// addenda of 2026-10-10), against the built site.
//
//   pnpm --filter @subrosa/website build        # the site, with Pyodide
//   PLAYWRIGHT_CORE=<path to playwright-core> [BROWSER_PATH=<a Chromium>] \
//     node website/scripts/python-sandbox-smoke.mjs chromium
//   PLAYWRIGHT_CORE=<path to playwright-core> node website/scripts/python-sandbox-smoke.mjs webkit
//   node website/scripts/python-sandbox-smoke.mjs serve [--simulator]
//
// Serves website/dist on a loopback origin with the policies of
// website/public/_headers (the sandbox page's, with the example origin
// replaced by the loopback one, and /app's for the harness page), seeds the
// page's `subrosa-browser-device` IndexedDB with a record, then runs Python
// two ways: in the sandboxed frame, as /app and the Excel pane do, and in a
// plain worker of the page, as the phone does (hardening alone). In each,
// every probe for a way out must raise, the chart, table, asyncio and pandas
// runs must answer, the device record must be untouched, and the server must
// see no request outside the harness, the sandbox page, its scripts and
// `/pyodide/`. `serve` waits for a browser to open the printed address and
// post its results (`--simulator` opens it in the booted iOS simulator's
// Safari with `xcrun simctl openurl`). Playwright is not a dependency of the
// repository; it launches the browsers its own version installed, or
// BROWSER_PATH (a cached headless shell, say).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(root, "website", "dist");
const mode = process.argv[2] ?? "chromium";
const EXAMPLE_ORIGIN = "https://account.example.invalid";

const headers = readFileSync(join(root, "website/public/_headers"), "utf8");
const policyOf = (pattern) => {
  const line = pattern.exec(headers)?.[1];
  if (!line) throw new Error(`No policy matching ${pattern} in website/public/_headers.`);
  return line;
};
const appPolicy = policyOf(/^\/app\n(?:.*\n)*?\s+Content-Security-Policy: ([^\n]+)/m);
const sandboxPolicy = policyOf(
  /^\/python-sandbox\.html\n(?:.*\n)*?\s+Content-Security-Policy: ([^\n]+)/m,
);
const workerAsset = readdirSync(join(dist, "assets")).find((name) =>
  /^python-sandbox\.worker-.*\.js$/.test(name),
);
if (!workerAsset || !statSync(join(dist, "pyodide", "pyodide.mjs"), { throwIfNoEntry: false }))
  throw new Error("Build the site with Pyodide first (pnpm --filter @subrosa/website build).");

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".zip": "application/zip",
  ".whl": "application/zip",
};

/** Every path the server was asked for, in order. */
const seen = [];
let reported = null;
let onReport = () => undefined;

const CSV = "region,sales\nNorth,1200\nSouth,800\nNorth,300\n";

/** [name, code, expectation]: "error" must raise, anything else is a test
 * on the answer. Probes reach for the network, the origin's storage and its
 * keys by every road the `js` and `pyodide_js` modules offer. */
const cases = (exfil) => [
  ["js.indexedDB", "import js\njs.indexedDB", "error"],
  ["js.XMLHttpRequest", "import js\njs.XMLHttpRequest", "error"],
  ["js.WebSocket", "import js\njs.WebSocket", "error"],
  ["js.EventSource", "import js\njs.EventSource", "error"],
  ["js.fetch", "import js\njs.fetch", "error"],
  ["js.crypto", "import js\njs.crypto.subtle", "error"],
  ["js.self", "import js\njs.self.indexedDB", "error"],
  ["run_js indexedDB", 'from pyodide.code import run_js\nrun_js("indexedDB")', "error"],
  ["run_js fetch", `from pyodide.code import run_js\nrun_js("fetch('${exfil}/run_js')")`, "error"],
  [
    "pyodide_js jsglobals",
    "import pyodide_js\npyodide_js._api.config.jsglobals.indexedDB",
    "error",
  ],
  [
    "pyodide_js Function",
    `import pyodide_js\npyodide_js.loadPackage.constructor("return fetch('${exfil}/function')")()`,
    "error",
  ],
  [
    "pyodide_js IDBFS",
    [
      "import asyncio, pyodide_js",
      "from pyodide.ffi import create_once_callable",
      "FS = pyodide_js.FS",
      "FS.mkdirTree('/subrosa-browser-device')",
      "FS.mount(FS.filesystems.IDBFS, FS.filesystems, '/subrosa-browser-device')",
      "done = asyncio.get_event_loop().create_future()",
      "FS.syncfs(True, create_once_callable(lambda error=None: done.set_result(error)))",
      "error = await done",
      "if error: raise RuntimeError(str(error))",
    ].join("\n"),
    "error",
  ],
  [
    "pyodide_js reachable globals",
    [
      "import pyodide_js",
      "from pyodide.ffi import jsnull",
      "found = []",
      "for root in ('_api', '_module'):",
      "    holder = getattr(pyodide_js, root)",
      "    for name in dir(holder):",
      "        try:",
      "            value = getattr(holder, name)",
      "        except Exception:",
      "            continue",
      "        for probe in ('indexedDB', 'XMLHttpRequest', 'WebSocket', 'caches'):",
      "            try:",
      "                reached = getattr(value, probe, None)",
      "                # Emscripten's IDBFS.indexedDB() is a lookup, not the factory.",
      "                if probe == 'indexedDB' and callable(reached):",
      "                    reached = reached()",
      "                if reached is not None and reached is not jsnull:",
      "                    found.append(f'{root}.{name}.{probe}')",
      "            except Exception:",
      "                pass",
      "found",
    ].join("\n"),
    (done) => done.error === null && done.result === "[]",
  ],
  ["pyfetch", `from pyodide.http import pyfetch\nawait pyfetch("${exfil}/pyfetch")`, "error"],
  ["pyxhr", `from pyodide.http import pyxhr\npyxhr.get("${exfil}/pyxhr")`, "error"],
  ["setTimeout string", `import js\njs.setTimeout("fetch('${exfil}/settimeout')", 0)`, "error"],
  ["urllib", `import urllib.request\nurllib.request.urlopen("${exfil}/urllib")`, "error"],
  [
    "chart",
    "subrosa_chart('bar', categories=['a', 'b'], series={'n': [1, 2]}, title='t')",
    (done) => done.error === null && done.blocks.length === 1 && done.blocks[0].kind === "chart",
  ],
  [
    "table",
    "subrosa_table([{'a': 1}, {'a': 2}], title='t')",
    (done) => done.error === null && done.blocks.length === 1 && done.blocks[0].kind === "table",
  ],
  [
    "asyncio.sleep",
    "import asyncio\nawait asyncio.sleep(0.05)\n'slept'",
    (done) => done.error === null && done.result === "'slept'",
  ],
  [
    "pandas",
    "import pandas as pd\ndf = pd.read_csv('/data/sales.csv')\nprint(df.groupby('region').sales.sum().to_dict())",
    (done) => done.error === null && done.stdout.includes("'North': 1500"),
  ],
];

/** The page's half, sent as a script: seeds the device record, runs every
 * case in `mode` ("sandbox" or "direct"), checks the record, reports. */
const harness = (workerUrl) => `
const MODE = new URLSearchParams(location.search).get("mode") || "sandbox";
const CASES = ${JSON.stringify(cases("EXFIL").map(([name, code]) => [name, code]))};
const EXFIL = location.origin + "/exfil";
const RECORD = { accountId: "smoke", key: "the browser device key" };

function openDevice(upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("subrosa-browser-device", 1);
    request.onupgradeneeded = () => upgrade && request.result.createObjectStore("devices", { keyPath: "accountId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function deviceState() {
  const db = await openDevice(false);
  const stores = [...db.objectStoreNames];
  const all = await new Promise((resolve, reject) => {
    const request = db.transaction("devices").objectStore("devices").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const state = JSON.stringify({ version: db.version, stores, all });
  db.close();
  return state;
}
async function seed() {
  const db = await openDevice(true);
  await new Promise((resolve, reject) => {
    const tx = db.transaction("devices", "readwrite");
    tx.objectStore("devices").put(RECORD);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function sandboxWorker() {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.hidden = true;
  frame.src = "/python-sandbox.html";
  const queue = [];
  let port = null;
  const worker = { onmessage: null, onerror: null,
    postMessage(message) { port ? port.postMessage(message) : queue.push(message); } };
  window.addEventListener("message", (event) => {
    if (port || event.source !== frame.contentWindow || event.data?.type !== "subrosa-python-sandbox-ready") return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (answer) => answer.data?.type === "subrosa-python-sandbox-failed"
      ? worker.onerror?.({ message: answer.data.message })
      : worker.onmessage?.({ data: answer.data });
    frame.contentWindow.postMessage({ type: "subrosa-python-sandbox-port" }, "*", [channel.port2]);
    for (const message of queue.splice(0)) port.postMessage(message);
  });
  document.body.append(frame);
  return worker;
}
function directWorker() {
  const blob = URL.createObjectURL(new Blob(['import ' + JSON.stringify(location.origin + ${JSON.stringify(workerUrl)}) + ';'], { type: "text/javascript" }));
  const url = window.trustedTypes
    ? trustedTypes.createPolicy("subrosa", { createScriptURL: (input) => input }).createScriptURL(blob)
    : blob;
  return new Worker(url, { type: "module", name: "python" });
}

(async () => {
  const report = { mode: MODE, userAgent: navigator.userAgent, cases: [], device: null, error: null };
  try {
    await seed();
    const before = await deviceState();
    const worker = MODE === "direct" ? directWorker() : sandboxWorker();
    const answers = new Map();
    worker.onmessage = (event) => answers.get(event.data?.id)?.(event.data);
    let failed = null;
    worker.onerror = (event) => { failed = "worker: " + (event.message || "failed"); };
    for (const [name, code] of CASES) {
      const answer = new Promise((resolve) => answers.set(name, resolve));
      worker.postMessage({ type: "run", id: name, session: "smoke", code: code.replaceAll("EXFIL", EXFIL),
        files: [{ path: "/data/sales.csv", text: ${JSON.stringify(CSV)} }] });
      const done = await Promise.race([
        answer,
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true, failed }), 120000)),
      ]);
      report.cases.push({ name, done });
      if (done.timedOut) break;
    }
    report.error = failed;
    report.device = { before, after: await deviceState() };
  } catch (error) {
    report.error = String((error && error.stack) || error);
  }
  window.__smokeReport = report;
  await fetch("/__smoke/report", { method: "POST", body: JSON.stringify(report) });
})();
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Python sandbox smoke</title></head><body><script src="/__smoke/harness.js"></script></body></html>`;

function startServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    seen.push(path);
    const origin = `http://${request.headers.host}`;
    if (path === "/__smoke/report" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        reported = JSON.parse(body);
        response.end("ok");
        onReport();
      });
      return;
    }
    if (path === "/__smoke/page.html") {
      const direct = url.searchParams.get("mode") === "direct";
      // The phone's shape: the page's policy with a blob worker, which the
      // app's own CSP grants. /app's own policy grants none any more.
      const policy = direct
        ? appPolicy.replace("worker-src 'self'", "worker-src 'self' blob:")
        : appPolicy;
      response.writeHead(200, { "content-type": "text/html", "content-security-policy": policy });
      response.end(PAGE);
      return;
    }
    if (path === "/__smoke/harness.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(harness(`/assets/${workerAsset}`));
      return;
    }
    if (path.startsWith("/exfil")) {
      response.writeHead(200, { "access-control-allow-origin": "*" });
      response.end("reached");
      return;
    }
    const file = normalize(join(dist, path));
    if (!file.startsWith(dist) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    const head = { "content-type": TYPES[extname(file)] ?? "application/octet-stream" };
    if (path === "/python-sandbox.html")
      head["content-security-policy"] = sandboxPolicy.replaceAll(EXAMPLE_ORIGIN, origin);
    if (path.startsWith("/assets/python-sandbox") || path.startsWith("/pyodide/"))
      head["access-control-allow-origin"] = "*";
    response.writeHead(200, head);
    response.end(readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(Number(process.env.SMOKE_PORT ?? 0), "127.0.0.1", () => resolve(server)),
  );
}

const ALLOWED = [
  /^\/__smoke\//,
  /^\/python-sandbox\.html$/,
  /^\/assets\/python-sandbox/,
  /^\/pyodide\//,
  /^\/favicon\.ico$/,
];

/** What failed in one report, as lines; none means it passed. */
function judge(report, outside) {
  const problems = [];
  if (!report) return ["no report"];
  if (report.error) problems.push(`page: ${report.error}`);
  const expected = new Map(cases("").map(([name, , expectation]) => [name, expectation]));
  for (const [name, expectation] of expected) {
    const entry = report.cases.find((item) => item.name === name);
    if (!entry) {
      problems.push(`${name}: not run`);
      continue;
    }
    const done = entry.done;
    if (done.timedOut) problems.push(`${name}: no answer${done.failed ? ` (${done.failed})` : ""}`);
    else if (done.unavailable) problems.push(`${name}: Python unavailable: ${done.error}`);
    else if (expectation === "error" ? !done.error : !expectation(done))
      problems.push(`${name}: unexpected ${JSON.stringify(done).slice(0, 300)}`);
  }
  if (!report.device || report.device.before !== report.device.after)
    problems.push(`device record changed: ${JSON.stringify(report.device)}`);
  if (!report.device?.before?.includes("the browser device key"))
    problems.push("device record was never seeded");
  for (const path of outside) problems.push(`request outside the sandbox's paths: ${path}`);
  return problems;
}

function print(label, report, problems) {
  process.stdout.write(
    `${problems.length ? "FAIL" : "ok"} ${label} (${report?.userAgent ?? "?"})\n`,
  );
  for (const entry of report?.cases ?? []) {
    const done = entry.done;
    const said = done.error
      ? done.error.trim().split("\n").at(-1)
      : (done.result ?? done.stdout ?? "");
    process.stdout.write(`  ${entry.name}: ${String(said).slice(0, 140)}\n`);
  }
  for (const problem of problems) process.stdout.write(`  ! ${problem}\n`);
}

const waitForReport = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    onReport = () => {
      clearTimeout(timer);
      resolve(reported);
    };
  });

const server = await startServer();
const origin = `http://127.0.0.1:${server.address().port}`;
let failures = 0;
try {
  for (const run of ["sandbox", "direct"]) {
    seen.length = 0;
    reported = null;
    const address = `${origin}/__smoke/page.html?mode=${run}`;
    const browserRequests = [];
    if (mode === "serve") {
      process.stdout.write(`open ${address}\n`);
      if (process.argv.includes("--simulator"))
        execFileSync("xcrun", ["simctl", "openurl", "booted", address]);
      await waitForReport(300_000);
    } else {
      const core = process.env.PLAYWRIGHT_CORE;
      if (!core) throw new Error("Set PLAYWRIGHT_CORE to a playwright-core install.");
      const playwright = await import(pathToFileURL(join(core, "index.mjs")).href);
      const browser = await playwright[mode].launch(
        process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {},
      );
      const context = await browser.newContext();
      context.on("request", (request) => browserRequests.push(request.url()));
      // Anything for another host would leave the machine: refuse and record.
      await context.route(
        (url) => url.origin !== origin,
        (route) => {
          browserRequests.push(`blocked ${route.request().url()}`);
          return route.abort();
        },
      );
      const page = await context.newPage();
      const log = (message) => {
        if (message.type() === "error" || process.env.SMOKE_VERBOSE)
          process.stdout.write(`  console: ${message.text()}\n`);
      };
      page.on("console", log);
      page.on("worker", (worker) => worker.on("console", log));
      context.on("requestfailed", (request) =>
        process.stdout.write(`  failed: ${request.url()} ${request.failure()?.errorText}\n`),
      );
      await page.goto(address);
      await waitForReport(300_000);
      await browser.close();
    }
    const outside = [
      ...seen.filter((path) => !ALLOWED.some((pattern) => pattern.test(path))),
      ...browserRequests.filter(
        (url) =>
          url.startsWith("blocked") ||
          (!url.startsWith("blob:") &&
            !url.startsWith("data:") &&
            !ALLOWED.some((pattern) => pattern.test(new URL(url).pathname))),
      ),
    ];
    const problems = judge(reported, [...new Set(outside)]);
    if (problems.length) failures++;
    print(`${mode} ${run}`, reported, problems);
  }
} finally {
  server.close();
}
process.exit(failures ? 1 : 0);
