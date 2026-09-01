import { describe, expect, it } from "vitest";
import { messageFromError } from "../lib/errors";

/**
 * The `[object Object]` guard.
 *
 * `err instanceof Error ? err.message : String(err)` reads like careful
 * defensive code and is exactly wrong here: a rejected Tauri `invoke` is a
 * plain `{ code, message }` object, so `instanceof` is false, `String` falls
 * through to the object, and the user is shown `[object Object]` at the one
 * moment they needed a sentence. It was in twenty-three call sites before
 * anybody noticed, because each one only shows itself when something fails.
 *
 * `messageFromError` is the one that knows the shape. This test exists because
 * the wrong version is the one that comes to mind first.
 *
 * The sources are read through `import.meta.glob` rather than `node:fs`: the
 * frontend tsconfig has no Node types, and this is the seam Vite gives a test
 * that needs to look at the code rather than run it.
 */

const SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

const BAD_PATTERN = /(\w+)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\(\1\)/;

describe("errors reaching the user", () => {
  it("never stringifies a rejected command straight into the UI", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !path.startsWith("../test/"))
      .filter(([, source]) => BAD_PATTERN.test(source))
      .map(([path]) => path.replace("../", "src/"));

    expect(
      offenders,
      "use messageFromError from lib/errors: a rejected invoke is a plain object, so `instanceof Error` is false and String() gives [object Object]",
    ).toEqual([]);
  });

  it("sees enough of the source to be worth anything", () => {
    // A glob that silently matched nothing would make the guard above pass
    // forever, which is the one way a test like this fails quietly.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(200);
  });

  it("reads the message off the object Tauri actually rejects with", () => {
    expect(messageFromError({ code: "council_no_evidence", message: "Nothing to judge." })).toBe(
      "Nothing to judge.",
    );
    // And still does the obvious thing for a real Error.
    expect(messageFromError(new Error("boom"))).toBe("boom");
  });
});
