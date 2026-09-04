// Rewrite file-size-ratchet.json from the tree: every source file above the
// ceiling, with its current line count. Run it after shrinking a file so the
// guard (src/test/file-size-ratchet.test.ts) holds the new size.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CEILING = 2000;
const SKIP_DIRS = new Set(["node_modules", "target", "gen", "test"]);

export function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path);
      } else if (/\.(ts|tsx|rs)$/.test(entry.name)) {
        out.push(path);
      }
    }
  };
  for (const base of ["src", "src-tauri/src"]) {
    if (statSync(join(root, base), { throwIfNoEntry: false })) walk(join(root, base));
  }
  return out;
}

export function exceptionsFor(root) {
  const entries = [];
  for (const file of sourceFiles(root)) {
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (lines > CEILING) entries.push([file.slice(root.length + 1), lines]);
  }
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries);
}

function main() {
  const root = process.cwd();
  const exceptions = exceptionsFor(root);
  writeFileSync(
    resolve(root, "file-size-ratchet.json"),
    `${JSON.stringify({ ceiling: CEILING, exceptions }, null, 2)}\n`,
  );
  process.stdout.write(
    `${Object.keys(exceptions).length} files above ${CEILING} lines recorded.\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
