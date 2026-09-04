import { describe, expect, it } from "vitest";
import ratchet from "../../file-size-ratchet.json";

// A file may only shrink.
//
// Ten files carry most of the codebase's weight (AgentWorkspace.tsx alone is
// thirteen thousand lines with sixty-six effects) and every metric that
// matters (hook-dependency warnings, test flakiness, review time) follows
// them. Splitting them is a month's work; this guard makes sure the month is
// not spent twice. Every file above the ceiling is listed with the size it
// had when the guard was written, and a change that makes one of them
// longer, or lifts a new file over the ceiling, fails here. When a file
// shrinks, lower its entry (or delete it once it is under the ceiling);
// `node scripts/file-size-ratchet.mjs` rewrites the list from the tree.
//
// Sources are read through Vite (import.meta.glob), never node:fs: the test
// tsconfig has no @types/node.
const frontend = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const rust = import.meta.glob("../../src-tauri/src/**/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
});

function repoPath(key: string) {
  // Keys are relative to this directory: ./x → src/test/x, ../x → src/x,
  // ../../src-tauri/... → src-tauri/...
  if (key.startsWith("../../")) return key.slice("../../".length);
  if (key.startsWith("./")) return `src/test/${key.slice("./".length)}`;
  return `src/${key.slice("../".length)}`;
}

function lineCount(raw: unknown) {
  return String(raw).split("\n").length;
}

describe("the file-size ratchet", () => {
  const ceiling: number = ratchet.ceiling;
  const exceptions: Record<string, number> = ratchet.exceptions;

  const sizes = new Map<string, number>();
  for (const [key, raw] of Object.entries(frontend)) {
    const path = repoPath(key);
    if (path.startsWith("src/test/")) continue;
    sizes.set(path, lineCount(raw));
  }
  for (const [key, raw] of Object.entries(rust)) {
    sizes.set(repoPath(key), lineCount(raw));
  }

  it("no file grows past the ceiling, or past its own recorded size", () => {
    const offenders: string[] = [];
    for (const [path, lines] of sizes) {
      const allowed = exceptions[path] ?? ceiling;
      if (lines > allowed) offenders.push(`${path}: ${lines} lines (allowed ${allowed})`);
    }
    expect(offenders).toEqual([]);
  });

  it("every exception still exists and is still above the ceiling", () => {
    const stale = Object.entries(exceptions)
      .filter(
        ([path, allowed]) =>
          !sizes.has(path) || (sizes.get(path) ?? 0) <= ceiling || allowed <= ceiling,
      )
      .map(([path]) => path);
    expect(stale).toEqual([]);
  });

  it("records the ceiling the guard was written with", () => {
    expect(ceiling).toBe(2000);
  });
});
