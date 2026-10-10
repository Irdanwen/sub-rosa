import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { pyodidePlugin } from "../scripts/pyodide-assets.mjs";
import { subresourceIntegrity } from "../website/vite-sri";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The development server's copy of the site's Python sandbox (ADR-0104
 * addendum of 2026-10-10), which the Excel pane frames: the built panes use
 * the site's own `/python-sandbox.html`. */
function pythonSandboxInDev(): Plugin {
  const page = here("../website/python-sandbox.html");
  const entry = here("../website/src/client/analysis/python-sandbox.ts");
  return {
    name: "subrosa-python-sandbox-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/python-sandbox.html", async (_request, response) => {
        const html = readFileSync(page, "utf8").replace(
          "/src/client/analysis/python-sandbox.ts",
          `/@fs${entry}`,
        );
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/python-sandbox.html", html));
      });
    },
  };
}

/**
 * The Office task panes (ADR-0102), built into the account site's `dist`
 * after the site itself: `/office/<host>.html` and their chunks under
 * `/office/assets/`. The base stays the site's root so the panes share its
 * `/pyodide/` and its environment (the Carpe Diem operator), and the account
 * origin serves them under the `/office/` policy of
 * `subrosa-cloud/deploy/nginx-account.conf.example`.
 */
export default defineConfig(({ command }) => ({
  base: "/",
  envDir: here("../website"),
  plugins: [
    react(),
    subresourceIntegrity(),
    // Pyodide is emitted by the site's own build; the dev server serves it.
    pyodidePlugin(here(".."), command === "serve" && process.env.SUBROSA_PYODIDE !== "0"),
    pythonSandboxInDev(),
  ],
  worker: { format: "es" },
  server: {
    port: 1431,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8088", changeOrigin: false },
      "/auth": { target: "http://127.0.0.1:8088", changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    outDir: here("../website/dist"),
    // The site's build empties dist and runs first; this one only adds to it.
    emptyOutDir: false,
    assetsDir: "office/assets",
    rollupOptions: {
      input: {
        word: here("office/word.html"),
        excel: here("office/excel.html"),
        powerpoint: here("office/powerpoint.html"),
        session: here("office/session.html"),
        commands: here("office/commands.html"),
      },
    },
  },
}));
