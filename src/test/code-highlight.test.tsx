import { render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { HighlightedCode } from "../components/chat/HighlightedCode";
import { noteSchemaExtensions } from "../components/note-editor/extensions";
import {
  codeLanguage,
  codeLanguagesLoaded,
  highlightCode,
  loadCodeLanguages,
} from "../lib/code-highlight";
import { docToMarkdown, markdownToDoc } from "../lib/note-markdown";
import { SimpleMarkdown } from "../lib/simple-markdown";

/**
 * Syntax colour for fenced code: one lazily loaded highlighter shared by the
 * note editor (a code canvas included) and the chat on both shells. Colour is
 * presentation only: the runs add up to the code, and the note's markdown is
 * byte for byte what it was.
 *
 * The suites run in order: the first asserts the state before the grammars
 * load, so it must not follow anything that loads them.
 */

const TS = "const total: number = 42; // the answer\nfunction add(a, b) { return a + b; }";

describe("before the grammars load", () => {
  it("shows code plain and loads nothing for a block with no language", () => {
    expect(codeLanguagesLoaded()).toBe(false);
    expect(highlightCode(TS, "ts")).toBeNull();
    const { container } = render(<HighlightedCode code="plain words" />);
    expect(container.textContent).toBe("plain words");
    expect(codeLanguagesLoaded()).toBe(false);
  });

  it("an editor holding a block that names a language loads them, then repaints", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: noteSchemaExtensions(),
      content: markdownToDoc("```python\nimport os\n```"),
    });
    expect(element.querySelector(".hljs-keyword")).toBeNull();
    await vi.waitFor(() =>
      expect(element.querySelector(".hljs-keyword")?.textContent).toBe("import"),
    );
    expect(codeLanguagesLoaded()).toBe(true);
    editor.destroy();
    element.remove();
  });
});

describe("the highlighter", () => {
  it("reads the language a fence names", () => {
    expect(codeLanguage("Python")).toBe("python");
    expect(codeLanguage("  ts {title=a.ts}")).toBe("ts");
    expect(codeLanguage("")).toBeNull();
    expect(codeLanguage(null)).toBeNull();
  });

  it("colours a known language, by alias too, and the runs add up to the code", async () => {
    await loadCodeLanguages();
    for (const language of ["typescript", "ts", "TS"]) {
      const spans = highlightCode(TS, language);
      expect(spans).not.toBeNull();
      expect(spans?.map((span) => span.text).join("")).toBe(TS);
      expect(spans?.find((span) => span.text === "const")?.className).toContain("hljs-keyword");
      expect(spans?.find((span) => span.text === "42")?.className).toContain("hljs-number");
      expect(spans?.find((span) => span.text.includes("the answer"))?.className).toContain(
        "hljs-comment",
      );
    }
  });

  it("leaves an unknown or missing language plain rather than guessing", async () => {
    await loadCodeLanguages();
    expect(highlightCode(TS, "cobol-ish")).toBeNull();
    expect(highlightCode(TS, "")).toBeNull();
    expect(highlightCode(TS, undefined)).toBeNull();
  });
});

describe("in a chat reply", () => {
  it("shows the plain text first, then the coloured code once the grammars are in", async () => {
    render(<HighlightedCode code={"def f():\n    return None"} language="python" />);
    expect(await screen.findByText("def")).toHaveClass("hljs-keyword");
    expect(screen.getByText("None")).toHaveClass("hljs-literal");
  });

  it("colours the phone's fenced code and keeps its own colouring for an unknown language", async () => {
    await loadCodeLanguages();
    const { container } = render(
      <SimpleMarkdown text={"```rust\nfn main() { let x = 1; }\n```\n\n```zzz\nlet y = 2\n```"} />,
    );
    const blocks = container.querySelectorAll("pre code");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].querySelector(".hljs-keyword")?.textContent).toBe("fn");
    expect(blocks[1].querySelector(".hljs-keyword")).toBeNull();
    expect(blocks[1].querySelector(".tok-keyword")?.textContent).toBe("let");
  });
});

describe("in the note editor", () => {
  const markdown =
    "Intro\n\n```python\nimport os\nprint('hi')  # greet\n```\n\n```\nplain block\n```";

  it("decorates a code block that names its language and leaves the file untouched", async () => {
    await loadCodeLanguages();
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: noteSchemaExtensions(),
      content: markdownToDoc(markdown),
    });
    const [python, plain] = Array.from(element.querySelectorAll("pre"));
    expect(python.querySelector(".hljs-keyword")?.textContent).toBe("import");
    expect(python.querySelector(".hljs-string")?.textContent).toBe("'hi'");
    expect(plain.querySelector("[class*='hljs-']")).toBeNull();
    // Decorations are not marks: the document, and so the file, is unchanged.
    expect(docToMarkdown(editor.state.doc)).toBe(markdown);
    editor.destroy();
    element.remove();
  });

  it("recolours a block as it is typed in", async () => {
    await loadCodeLanguages();
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: noteSchemaExtensions(),
      content: markdownToDoc("```js\nx\n```"),
    });
    expect(element.querySelector(".hljs-keyword")).toBeNull();
    editor.commands.insertContentAt(1, "return ");
    expect(element.querySelector(".hljs-keyword")?.textContent).toBe("return");
    editor.destroy();
    element.remove();
  });
});
