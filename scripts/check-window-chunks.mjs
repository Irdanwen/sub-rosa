// The small desktop windows load only what they use (run after `pnpm build`).
//
// Each HUD is its own page with its own entry, and the bundler decides which
// shared chunks it preloads. A chunking change can quietly make a window that
// draws a level meter download the note editor or every language: the switch
// to Rolldown (vite 8) did both, and nothing failed, because the app still
// worked, only slower to open. This reads the built pages and fails when a
// window preloads a chunk it was never meant to need.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2] ?? "dist";

// Chunk names (before the hash) a window must not preload.
const forbidden = {
  hud: ["editor", "flow", "motion"],
  "agent-hud": ["editor", "flow", "motion"],
  "chat-bar": ["editor", "flow"],
  // The meeting HUD draws bars from levels: no React, no text catalog.
  "meeting-hud": ["editor", "flow", "motion", "react", "i18n"],
};

let failed = false;
for (const [page, names] of Object.entries(forbidden)) {
  const html = readFileSync(join(dist, `${page}.html`), "utf8");
  const chunks = [...html.matchAll(/\/assets\/([^"/]+?)-[A-Za-z0-9_-]{8}\.js/g)].map((m) => m[1]);
  const found = names.filter((name) => chunks.includes(name));
  if (found.length > 0) {
    failed = true;
    console.error(
      `${page}.html preloads ${found.join(", ")}: check the codeSplitting groups in vite.config.ts`,
    );
  }
}
if (failed) process.exit(1);
console.log("window chunks: every HUD loads only its own share");
