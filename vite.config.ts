import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { pyodidePlugin } from "./scripts/pyodide-assets.mjs";

export default defineConfig({
  // Pyodide rides only in the phone bundles (ADR-0086).
  plugins: [react(), pyodidePlugin()],
  // The Python worker loads Pyodide with a dynamic import, which a classic
  // worker cannot do.
  worker: { format: "es" },
  clearScreen: false,
  define: {
    __APP_COMMIT_HASH__: JSON.stringify(gitCommitHash()),
  },
  server: {
    // TAURI_DEV_HOST is set by `tauri ios dev`/`tauri android dev` so a
    // physical device can reach the dev server over the local network.
    host: process.env.TAURI_DEV_HOST || "127.0.0.1",
    port: 1421,
    strictPort: true,
    // Vite's file watcher must not descend into the Rust build-output dirs.
    // On Windows, cargo locks `.exe`/pdb files in `target/` while linking, and
    // `fs.watch` throws EBUSY on locked files. An unhandled watcher error
    // crashes Vite and tears down `tauri dev` mid-compile. macOS's FSEvents
    // watcher doesn't hit this, so the gap only shows on Windows (upstream #624).
    watch: {
      ignored: ["**/src-tauri/target/**", "**/june-api/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: !process.env.TAURI_DEBUG,
    sourcemap: Boolean(process.env.TAURI_DEBUG),
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        hud: fileURLToPath(new URL("./hud.html", import.meta.url)),
        "agent-hud": fileURLToPath(new URL("./agent-hud.html", import.meta.url)),
        "chat-bar": fileURLToPath(new URL("./chat-bar.html", import.meta.url)),
        "meeting-hud": fileURLToPath(new URL("./meeting-hud.html", import.meta.url)),
      },
      output: {
        // Vendor code that changes on its own schedule sits in its own
        // chunk, so an app release does not make the webview re-parse the
        // editor or the animation runtime, and the note list can paint
        // before the canvas libraries are even requested.
        //
        // A group also takes in what its modules import, so the order is
        // load-bearing: React goes first, or the editor's React bindings
        // carry React into `editor` and every HUD window loads the editor to
        // get React. The locale catalogs are a group of their own for a
        // subtler reason: when every chunk comes from automatic splitting,
        // Rolldown puts its helpers (`__commonJS`, `__export`) in a shared
        // chunk, here the catalogs, and a HUD that imports one Tauri module
        // downloads every language; with them grouped, the helpers get their
        // own `rolldown-runtime` chunk.
        codeSplitting: {
          groups: [
            {
              name: "react",
              priority: 40,
              test: /node_modules[\\/](react-dom|react|scheduler)[\\/]/,
            },
            {
              name: "motion",
              priority: 30,
              test: /node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/,
            },
            { name: "flow", priority: 20, test: /node_modules[\\/](@xyflow|d3-[a-z-]+)[\\/]/ },
            {
              name: "editor",
              priority: 10,
              test: /node_modules[\\/](prosemirror-[a-z-]+|@tiptap|linkifyjs)[\\/]/,
            },
            { name: "i18n", priority: 5, test: /src[\\/](lib[\\/]i18n\.ts|locales[\\/])/ },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/test/**/*.{test,spec}.{ts,tsx,mjs}"],
    css: true,
    coverage: {
      provider: "v8",
      // json-summary feeds scripts/coverage-floor.mjs, the ratchet CI reads.
      reporter: ["text", "html", "lcov", "json-summary"],
      // The floor check reads the summary after the run; a teardown flake in
      // one suite must not leave it unwritten (the default drops the report
      // on any failure).
      reportOnFailure: true,
      reportsDirectory: "coverage/frontend",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // Vitest 4 matches these globs anywhere in a loaded file's absolute
        // path (picomatch `contains`), so `src/**` also takes in the sibling
        // workspace packages the website and office tests import. The floor
        // measures the app's own `src/`, as it did under vitest 3.
        "website/src/**",
        "office-addins/src/**",
        "browser-extension/src/**",
        "packages/*/src/**",
        "src/test/**",
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/hud.ts",
        "src/agent-hud.ts",
        "src/chat-bar.tsx",
      ],
    },
  },
});

function gitCommitHash() {
  try {
    return (
      execSync("git rev-parse --short HEAD", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() || "unknown"
    );
  } catch {
    return "unknown";
  }
}
