#!/usr/bin/env node
/**
 * The sentences the Rust side sends to the screen (`AppError::new(code,
 * "…")` with a literal message), so the catalog can translate them too
 * (ADR-0047). `messageFromError` passes every backend message through
 * `t()`; a message built with `format!` keeps its English, which is the
 * documented limit.
 *
 *   node scripts/i18n/rust-messages.mjs   # writes src/locales/backend-messages.json
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".rs")) files.push(path);
  }
}
walk("src-tauri/src");

const pattern = /AppError::new\(\s*"[a-z_0-9]+"\s*,\s*"((?:[^"\\]|\\.)*)"\s*[,)]/g;
const sentences = new Set();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(pattern)) {
    const text = match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
    // Codes echoed as messages ("no_speech") are not sentences.
    if (/\s/.test(text) && /[A-Za-z]{2,}/.test(text)) sentences.add(text);
  }
}
const list = [...sentences].sort((a, b) => a.localeCompare(b, "en"));
writeFileSync("src/locales/backend-messages.json", `${JSON.stringify(list, null, 2)}\n`);
console.log(`${list.length} backend sentences`);
