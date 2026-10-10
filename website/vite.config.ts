import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { checkOrigin, PRODUCTION_OFFICE_ORIGIN } from "../scripts/office-origins.mjs";
import { pyodidePlugin } from "../scripts/pyodide-assets.mjs";
import { subresourceIntegrity } from "./vite-sri";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const base = env.VITE_SITE_BASE || "/";
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))
    throw new Error("VITE_SITE_BASE must be an absolute path with a trailing slash.");
  if (env.VITE_ACCOUNT_ORIGIN) {
    const origin = new URL(env.VITE_ACCOUNT_ORIGIN);
    if (origin.protocol !== "https:" || origin.origin !== env.VITE_ACCOUNT_ORIGIN)
      throw new Error("VITE_ACCOUNT_ORIGIN must be an HTTPS origin without a path.");
  }
  // The only origin the Office courier frame answers (ADR-0102, addendum).
  const officeOrigin = checkOrigin(
    env.VITE_OFFICE_ORIGIN || PRODUCTION_OFFICE_ORIGIN,
    "VITE_OFFICE_ORIGIN",
  );
  const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  return {
    base,
    define: { "import.meta.env.VITE_OFFICE_ORIGIN": JSON.stringify(officeOrigin) },
    // The web client's Python (ADR-0086 on the web) is served from the site's
    // own origin under /pyodide/, verified by hash at build, never from a CDN
    // at run time. SUBROSA_PYODIDE=0 builds the site without it.
    plugins: [
      react(),
      subresourceIntegrity(),
      pyodidePlugin(
        fileURLToPath(new URL("..", import.meta.url)),
        process.env.SUBROSA_PYODIDE !== "0",
      ),
    ],
    // The Python worker loads Pyodide with a dynamic import, which a classic
    // worker cannot do.
    worker: { format: "es" },
    server: {
      proxy: {
        "/api": { target: "http://127.0.0.1:8088", changeOrigin: false },
        "/auth": { target: "http://127.0.0.1:8088", changeOrigin: false },
      },
    },
    build: {
      target: "es2022",
      sourcemap: false,
      // The Python sandbox (python-sandbox.html, ADR-0104 addendum of
      // 2026-10-10) is a page of its own whose scripts are fetched from an
      // opaque origin, so only `/assets/python-sandbox*` answers it with
      // CORS. The preload polyfill would be a chunk both pages share, under
      // another name; every browser the site supports preloads modules
      // natively, and one that does not loads them on import as before.
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          index: page("index.html"),
          "python-sandbox": page("python-sandbox.html"),
          // The Office add-ins' two account-origin pages (ADR-0102,
          // addendum): neither runs Office.js, which stays on its own origin.
          "office-courier": page("office/courier.html"),
          "office-signed-in": page("office/signed-in.html"),
        },
      },
    },
  };
});
