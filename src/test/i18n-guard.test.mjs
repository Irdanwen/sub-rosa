import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Copy reaches the screen through t() (ADR-0047, spec copy-through-t). The
 * two codemods that did the first pass double as the guard: run dry, they
 * must find nothing left to wrap. A new component with bare copy turns this
 * red until its sentences go through t(), which is when they enter the
 * catalog and get their French.
 */
function dryRun(script) {
  return execFileSync("node", [script], { encoding: "utf8" }).split("\n")[0];
}

describe("the copy guard", () => {
  it("finds no JSX text or copy attribute left outside t()", () => {
    expect(dryRun("scripts/i18n/codemod.mjs")).toMatch(/^would rewrite 0 files: 0 texts, 0 runs/);
  });

  it("finds no copy property or status sentence left outside t()", () => {
    expect(dryRun("scripts/i18n/literals.mjs")).toMatch(
      /^would rewrite 0 files: 0 properties, 0 sink/,
    );
  });
});
