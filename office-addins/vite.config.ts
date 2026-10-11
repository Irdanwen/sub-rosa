import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { officeOrigins } from "../scripts/office-origins.mjs";
import { pyodidePlugin } from "../scripts/pyodide-assets.mjs";
import { subresourceIntegrity } from "../website/vite-sri";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The Office task panes (ADR-0102 and its addendum of 2026-10-10), built into
 * `office-addins/dist` and served by their own origin
 * (`office.subrosa.furetier.com`, `subrosa-cloud/deploy/nginx-office.conf.example`):
 * `/office/<host>.html`, the sign-in window, their chunks under
 * `/office/assets/`, and, for the Excel pane, Pyodide under `/pyodide/` and
 * the Python sandbox it frames, `/python-sandbox.html` (ADR-0104 addendum of
 * 2026-10-10), this origin's own copy of the site's.
 *
 * Both origins are baked in: `VITE_ACCOUNT_ORIGIN` (where the service and the
 * courier frame answer, and the URL device proofs are signed for) and
 * `VITE_OFFICE_ORIGIN` (this build's own). Unset, they are production's.
 */
export default defineConfig(({ command, mode }) => {
  const origins = officeOrigins(loadEnv(mode, here("../website"), "VITE_"));
  return {
    base: "/",
    // The site's environment (the Carpe Diem operator) applies to the panes too.
    envDir: here("../website"),
    define: {
      "import.meta.env.VITE_ACCOUNT_ORIGIN": JSON.stringify(origins.account),
      "import.meta.env.VITE_OFFICE_ORIGIN": JSON.stringify(origins.office),
    },
    plugins: [
      react(),
      subresourceIntegrity(),
      // The Excel pane runs Python from this origin's /pyodide/, in the dev
      // server and in the build alike. SUBROSA_PYODIDE=0 leaves it out.
      pyodidePlugin(here(".."), process.env.SUBROSA_PYODIDE !== "0"),
    ],
    worker: { format: "es" },
    // The panes never call the account service themselves (the sign-in
    // window's courier does), so the dev server proxies nothing.
    server: { port: 1431, strictPort: true },
    build: {
      target: "es2022",
      sourcemap: false,
      outDir: here("dist"),
      emptyOutDir: command === "build",
      assetsDir: "office/assets",
      // The sandbox's scripts are fetched from an opaque origin, so only
      // `/office/assets/python-sandbox*` answers it with CORS; the preload
      // polyfill would be a chunk it shares with the panes (as on the site).
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          word: here("office/word.html"),
          excel: here("office/excel.html"),
          powerpoint: here("office/powerpoint.html"),
          session: here("office/session.html"),
          commands: here("office/commands.html"),
          "python-sandbox": here("python-sandbox.html"),
        },
      },
    },
  };
});
