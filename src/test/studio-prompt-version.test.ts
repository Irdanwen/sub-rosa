import { describe, expect, it } from "vitest";
import rust from "../../src-tauri/src/studio_ai/prompts.rs?raw";
import { SHOT_REWRITE_VERSION } from "../lib/studio/studio-rewrite";

// Read through Vite (?raw), never node:fs: the test tsconfig has no @types/node.
describe("the rewrite version", () => {
  it("is the one the Rust rewrite stamps, so an older prompt can say so", () => {
    expect(rust).toContain(`STUDIO_AI_PROMPT_VERSION: &str = "${SHOT_REWRITE_VERSION}"`);
  });
});
