import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        hud: fileURLToPath(new URL("./hud.html", import.meta.url)),
        "agent-hud": fileURLToPath(new URL("./agent-hud.html", import.meta.url)),
        "meeting-hud": fileURLToPath(new URL("./meeting-hud.html", import.meta.url)),
      },
      output: {
        // Vendor code that changes on its own schedule sits in its own
        // chunk, so an app release does not make the webview re-parse the
        // editor or the animation runtime, and the note list can paint
        // before the canvas libraries are even requested.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](prosemirror-[a-z-]+|@tiptap|linkifyjs)[\\/]/.test(id)) return "editor";
          if (/[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return "motion";
          if (/[\\/](@xyflow|d3-[a-z-]+)[\\/]/.test(id)) return "flow";
          if (/[\\/](react-dom|react|scheduler)[\\/]/.test(id)) return "react";
          return undefined;
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
      exclude: ["src/test/**", "src/**/*.d.ts", "src/main.tsx", "src/hud.ts", "src/agent-hud.ts"],
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
