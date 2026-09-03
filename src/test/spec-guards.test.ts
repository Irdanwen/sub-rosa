import { describe, expect, it } from "vitest";

// A spec that names a test which does not exist is a rule nobody holds. The
// sources are read through Vite (import.meta.glob), never node:fs: the test
// tsconfig has no @types/node.
const specs = import.meta.glob("../../spec/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const rustTests = import.meta.glob("../../src-tauri/tests/*.rs");
const frontTests = import.meta.glob("./**/*.test.{ts,tsx,mjs}");
const index = import.meta.glob("../../spec/index.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

function exists(path: string) {
  if (path.startsWith("src-tauri/tests/")) {
    return Object.keys(rustTests).some((key) => key.endsWith(path.slice("src-tauri/".length)));
  }
  if (path.startsWith("src/test/")) {
    return Object.keys(frontTests).some((key) => key.endsWith(path.slice("src/test/".length)));
  }
  return true;
}

describe("the specs", () => {
  it("every test a spec cites in its Held by line exists", () => {
    const missing: string[] = [];
    for (const [file, raw] of Object.entries(specs)) {
      const text = String(raw);
      const held = text.split("**Held by.**")[1] ?? "";
      for (const match of held.matchAll(/`((?:src-tauri\/tests|src\/test)\/[^`]+)`/g)) {
        if (!exists(match[1])) missing.push(`${file.split("/").pop()} → ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every spec file is listed in the index, and nothing listed is missing", () => {
    const indexText = String(Object.values(index)[0]);
    const listed = [...indexText.matchAll(/\]\(([a-z0-9-]+\.md)\)/g)].map((m) => m[1]);
    const files = Object.keys(specs)
      .map((key) => key.split("/").pop() ?? "")
      .filter((name) => name !== "index.md");
    expect([...listed].sort()).toEqual([...files].sort());
  });
});
