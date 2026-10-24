// The Code mode prompt (lot C1.4) lives in Rust, in src-tauri/src/code/prompts/,
// and both the app and the code CLI read it there. These checks hold the two
// sides together: the version the front names is Rust's, and the family table
// Rust is tested against uses ids a person can actually pick.

import { describe, expect, it } from "vitest";
import cases from "../../src-tauri/src/code/prompts/family-cases.json";
import rust from "../../src-tauri/src/code/prompts/mod.rs?raw";
import snapshot from "../../website/src/models/snapshot.json";
import { CODE_PROMPT_VERSION } from "../lib/code-mode";

// Read through Vite (?raw), never node:fs: the test tsconfig has no @types/node.
describe("the Code mode prompt", () => {
  it("has the version Rust stamps on every block", () => {
    expect(rust).toContain(`CODE_PROMPT_VERSION: &str = "${CODE_PROMPT_VERSION}"`);
  });

  it("is tested against real catalog ids, every family reached", () => {
    const catalog = new Set(snapshot.models.map((model: { id: string }) => model.id));
    for (const entry of cases.cases) {
      expect([entry.model, catalog.has(entry.model)]).toEqual([entry.model, true]);
      expect(["v4a", "replace"]).toContain(entry.editFormat);
    }
    const families = new Set(cases.cases.map((entry) => entry.family));
    expect([...families].sort()).toEqual(
      ["anthropic", "codex", "deepseek", "generic", "glm", "gpt", "grok", "kimi"].sort(),
    );
  });

  it("gives V4A to the GPT and Codex models only", () => {
    for (const entry of cases.cases) {
      const v4a = entry.family === "gpt" || entry.family === "codex";
      expect([entry.model, entry.editFormat]).toEqual([entry.model, v4a ? "v4a" : "replace"]);
    }
  });
});
