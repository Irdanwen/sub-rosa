import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * `messageFromError` is the one that knows the shape. This test is here
 * because the wrong version is the one that comes to mind first.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BAD_PATTERN = /(\w+)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\(\1\)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "test" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("errors reaching the user", () => {
  it("never stringifies a rejected command straight into the UI", () => {
    const offenders = sourceFiles(ROOT)
      .filter((file) => BAD_PATTERN.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(ROOT.length + 1));

    expect(
      offenders,
      "use messageFromError from lib/errors: a rejected invoke is a plain object, so `instanceof Error` is false and String() gives [object Object]",
    ).toEqual([]);
  });

  it("reads the message off the object Tauri actually rejects with", () => {
    expect(messageFromError({ code: "council_no_evidence", message: "Nothing to judge." })).toBe(
      "Nothing to judge.",
    );
    // And still does the obvious thing for a real Error.
    expect(messageFromError(new Error("boom"))).toBe("boom");
  });
});
