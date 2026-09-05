import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findRenderedCopy } from "../../scripts/i18n/rendered-copy.mjs";

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

  // The original codemods miss output branches and templates. Follow those
  // throughout shipped TSX, including library renderers. This is a syntax
  // gate, not interprocedural proof: helper-returned copy also needs review.
  it("finds no untranslated rendered copy in either shell", () => {
    function filesIn(dir) {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          // The note-lab harness is not a build input.
          return ["test", "dev", "locales"].includes(entry.name) ? [] : filesIn(file);
        }
        return entry.name.endsWith(".tsx") ? [file] : [];
      });
    }
    const untranslated = filesIn("src").flatMap((file) =>
      findRenderedCopy(readFileSync(file, "utf8"), file)
        // Example credentials are data, per spec/copy-through-t.md.
        .filter(
          (entry) =>
            !(
              file === "src/components/mobile/screens/ConnectionScreen.tsx" &&
              entry.text === "AIza…"
            ),
        )
        .map((entry) => ({ file, ...entry })),
    );
    expect(untranslated).toEqual([]);
  });
});

describe("the rendered-copy scanner", () => {
  it("checks plain JSX, copy attributes and sentences starting with punctuation", () => {
    const source =
      '<><p>Ready to write</p><button aria-label="Copy code">{`. Your draft is saved.`}</button></>';
    expect(findRenderedCopy(source).map((entry) => entry.text)).toEqual([
      "Ready to write",
      "Copy code",
      ". Your draft is saved.",
    ]);
  });
  it("follows nested conditional output and copy attributes, never their conditions", () => {
    const source = `<><button>{mode === "generate" ? busy ? "Working…" : "Generate" : "Edit"}</button><input placeholder={ready ? "Describe the scene" : "Wait"} data-mode={ready ? "enabled" : "disabled"} /></>`;
    expect(findRenderedCopy(source).map((entry) => entry.text)).toEqual([
      "Working…",
      "Generate",
      "Edit",
      "Describe the scene",
      "Wait",
    ]);
  });

  it("finds template sentences and fallback copy", () => {
    const source =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is TSX source for the scanner
      '<><p>{`${count} renders in progress`}</p><span>{failure ?? "The render failed."}</span><p>{ready && "Ready to create"}</p></>';
    expect(findRenderedCopy(source).map((entry) => entry.text)).toEqual([
      " renders in progress",
      "The render failed.",
      "Ready to create",
    ]);
  });

  it("leaves translated calls, identifiers, code, empty strings and technical values alone", () => {
    const source =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is TSX source for the scanner
      '<><button className={busy ? "button-primary" : "button"} onClick={() => send("generate")}>{busy ? t("Working…") : name}</button><code>{ready ? "Generate" : "Edit"}</code><pre><span>{"Raw code"}</span></pre><p>{ready ? "" : "glm-5.2"}</p><span>{`${count} / ${limit}`}</span><p>{ready ? "https://example.com" : "file.png"}</p></>';
    expect(findRenderedCopy(source)).toEqual([]);
  });
});
