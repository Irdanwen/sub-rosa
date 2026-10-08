// Pyodide for the phone's `run_python` tool (ADR-0086), bundled with the app.
//
// The webview may only reach the app itself and loopback (CSP connect-src),
// so the Python runtime cannot come from a CDN at run time: it ships inside
// the iOS and Android bundles under `/pyodide/`. The files are pinned here by
// SHA-256, downloaded once into node_modules/.cache and verified on every
// build, so a tampered or truncated download fails the build rather than
// shipping. Desktop builds skip all of it: the desktop agent has Hermes'
// own Python, and twenty megabytes it never loads would be pure weight.
//
// Upgrading: change PYODIDE_VERSION, re-pin each file's hash and size from
// the release's pyodide-lock.json (wheels) and the files themselves (core),
// and re-run the phone checks in docs/adr/0086.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

export const PYODIDE_VERSION = "0.29.5";
const BASE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** [file, sha256, bytes]. numpy and pandas with pandas' three pure-Python
 * dependencies; nothing else is ever loaded. */
export const PYODIDE_FILES = [
  ["pyodide.mjs", "510ca14305230018f50c40fb81be673afd68080e70ce7733fcce6600dd6a1714", 17616],
  ["pyodide.asm.js", "356c42f69e1695397e9d8670bd3c2e678248cde76e18bdae1731e848537b47d7", 1074322],
  ["pyodide.asm.wasm", "54309a5a2cfd757b1f0fdbc9093c92503f7b341500110329d932487183912718", 8647684],
  [
    "python_stdlib.zip",
    "831fd1e535084b972f87c6a35275de3d236efd5166f5e77ce89497710635e73c",
    2424003,
  ],
  ["pyodide-lock.json", "14d2c2dba101277999e17135e653d8f15389ad1437f53eae213bf0c3cdff723d", 122027],
  [
    "numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl",
    "800c98edc0c864dfa49f07005680c699b4b42b84eae1f8cb19d35b3634e7f05c",
    2823762,
  ],
  [
    "pandas-2.3.3-cp313-cp313-pyemscripten_2025_0_wasm32.whl",
    "2579a3d8e9f040421836365ccf7886fc4054c87381d4d481840a97785cd78923",
    4493372,
  ],
  [
    "python_dateutil-2.9.0.post0-py2.py3-none-any.whl",
    "1fe3a0346ef21bc85b295227256d6aed72aa8116178b019fc5ae5d57fbd213cf",
    229892,
  ],
  [
    "pytz-2025.2-py2.py3-none-any.whl",
    "d7fb2f11cf7f8dd17e652d5494189f520ee086e9fc71aef4cbb978f5dcfc2878",
    509225,
  ],
  [
    "six-1.17.0-py2.py3-none-any.whl",
    "bc830cfdc71a224b6d0e4337183a87ea53f21b6623deca5771ee3bc866fd8da2",
    11050,
  ],
];

const MIME = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".zip": "application/zip",
  ".whl": "application/zip",
};

/** Whether this build ships Python: the phone targets, or an explicit opt-in
 * (`SUBROSA_PYODIDE=1`) for driving the bridge in a desktop browser. */
export function pyodideWanted(env = process.env) {
  if (env.SUBROSA_PYODIDE === "0") return false;
  return (
    env.SUBROSA_PYODIDE === "1" ||
    env.TAURI_ENV_PLATFORM === "ios" ||
    env.TAURI_ENV_PLATFORM === "android"
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function cacheDir(root) {
  return join(root, "node_modules", ".cache", "subrosa-pyodide", PYODIDE_VERSION);
}

/** Downloads what is missing, verifies everything, returns the folder. */
export async function ensurePyodideCache(root, log = console.log) {
  const dir = cacheDir(root);
  mkdirSync(dir, { recursive: true });
  for (const [name, hash, size] of PYODIDE_FILES) {
    const path = join(dir, name);
    if (existsSync(path) && sha256(readFileSync(path)) === hash) continue;
    log(`pyodide: fetching ${name}`);
    const response = await fetch(`${BASE_URL}${name}`);
    if (!response.ok) throw new Error(`pyodide: ${name} answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== size || sha256(bytes) !== hash) {
      throw new Error(`pyodide: ${name} does not match its pinned hash`);
    }
    writeFileSync(`${path}.part`, bytes);
    renameSync(`${path}.part`, path);
  }
  return dir;
}

export function pyodideBytes() {
  return PYODIDE_FILES.reduce((sum, [, , size]) => sum + size, 0);
}

/** The Vite side: served under /pyodide/ in dev, emitted into the bundle at
 * build, only for builds that want it. The website asks for it itself (its
 * web client runs Python in the tab, served from the site's own origin), so
 * it passes `wanted`; the app leaves it to `pyodideWanted`. */
export function pyodidePlugin(root = process.cwd(), wanted = pyodideWanted()) {
  return {
    name: "subrosa-pyodide",
    async configureServer(server) {
      if (!wanted) return;
      const dir = await ensurePyodideCache(root);
      server.middlewares.use("/pyodide/", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0].replace(/^\//, ""));
        const known = PYODIDE_FILES.some(([file]) => file === name);
        if (!known) return next();
        const extension = name.slice(name.lastIndexOf("."));
        res.setHeader("Content-Type", MIME[extension] ?? "application/octet-stream");
        res.end(readFileSync(join(dir, name)));
      });
    },
    async generateBundle() {
      if (!wanted) return;
      const dir = await ensurePyodideCache(root);
      for (const [name] of PYODIDE_FILES) {
        this.emitFile({
          type: "asset",
          fileName: `pyodide/${name}`,
          source: readFileSync(join(dir, name)),
        });
      }
    },
  };
}
