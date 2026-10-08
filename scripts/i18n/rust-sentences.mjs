/**
 * The sentences the Rust side shows (ADR-0047): the literal message of an
 * `AppError::new(code, "…")`, which reaches the screen through
 * `messageFromError` and `t()`, and every `tr!("…")`, which Rust renders
 * itself from the same catalog (notifications, src-tauri/src/i18n.rs). A
 * message built with `format!` keeps its English, which is the documented
 * limit; `tr!` takes only a literal, so it has none.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ERROR = /AppError::new\(\s*"[a-z_0-9]+"\s*,\s*"((?:[^"\\]|\\.)*)"\s*[,)]/g;
const TR = /\btr!\(\s*"((?:[^"\\]|\\.)*)"\s*[,)]/g;

function unescapeRust(text) {
  return text.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

/** The sentences one Rust source carries, comments left out. Pure. */
export function sentencesIn(raw) {
  const source = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const found = new Set();
  for (const match of source.matchAll(ERROR)) {
    const text = unescapeRust(match[1]);
    // Codes echoed as messages ("no_speech") are not sentences.
    if (/\s/.test(text) && /[A-Za-z]{2,}/.test(text)) found.add(text);
  }
  // A tr! literal is a sentence by construction, one word included.
  for (const match of source.matchAll(TR)) found.add(unescapeRust(match[1]));
  return found;
}

/** Every sentence under `root` (src-tauri/src by default), sorted. */
export function collectRustSentences(root = "src-tauri/src") {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".rs")) files.push(path);
    }
  };
  walk(root);
  const sentences = new Set();
  for (const file of files) {
    for (const sentence of sentencesIn(readFileSync(file, "utf8"))) sentences.add(sentence);
  }
  return [...sentences].sort((a, b) => a.localeCompare(b, "en"));
}
