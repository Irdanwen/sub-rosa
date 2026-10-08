import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectRustSentences } from "../../scripts/i18n/rust-sentences.mjs";
import { createRequire } from "node:module";

const fr = createRequire(import.meta.url)("../locales/fr.json");

/**
 * Connectors and skill packs (ADR-0092) built their error messages in helper
 * functions: `AppError::new(code, match code { … })`, `format!(…)` and
 * sentences stored as a connector's last error. The extractor sees none of
 * those, so they showed in English in French. Every sentence there is now a
 * literal it reads (`AppError::new("code", "…")` or `tr!("…")`), and this
 * keeps it that way.
 */
const ROOTS = ["src-tauri/src/connectors", "src-tauri/src/skill_packs"];

function shippingSources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        // The `tests/` directory under a module is fixtures.
        if (name !== "tests") walk(path);
      } else if (name.endsWith(".rs") && !name.endsWith("tests.rs")) {
        const source = readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("//"))
          .join("\n");
        // Inline test modules hold fixtures too.
        out.push({ path, source: source.split("#[cfg(test)]\nmod tests")[0] ?? source });
      }
    }
  };
  for (const root of ROOTS) walk(root);
  return out;
}

describe("connector and skill pack copy", () => {
  const sources = shippingSources();

  it("never builds an error message the extractor cannot read", () => {
    for (const { path, source } of sources) {
      // A code passed through a variable means the message was picked by a
      // match the extractor does not follow.
      expect(source, path).not.toMatch(/AppError::new\(\s*code\s*,/);
      // A formatted message keeps its English.
      expect(source, path).not.toMatch(/AppError::new\(\s*"[a-z_]+"\s*,\s*format!/);
      // A connector's or trigger's last error is shown to the person.
      expect(source, path).not.toMatch(/set_status\([^;]*Some\("/);
      expect(source, path).not.toMatch(/record\([^;]*Some\("/);
    }
  });

  it("puts every one of their sentences in the catalog, translated", () => {
    const sentences = collectRustSentences();
    const catalog = fr;
    for (const sentence of [
      "This connector no longer exists.",
      "This connector does not say how to sign in. Check its address.",
      "The connector answered with status {status}.",
      "The connector refused: {reason}",
      "Sign in again to keep using this connector.",
      "The sign-in was cancelled.",
      "This file is not a skill. It needs a name and a description at the top, between two lines of three dashes.",
      '{connector} wants to run "{tool}". It changes something in that service, so Sub Rosa asks you first.',
    ]) {
      expect(sentences).toContain(sentence);
      expect(catalog[sentence], sentence).toBeTruthy();
      expect(catalog[sentence], sentence).not.toBe(sentence);
    }
  });
});
