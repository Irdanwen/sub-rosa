import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotePreview } from "../components/note-editor/NotePreview";

/**
 * The wiring, as opposed to the conversion.
 *
 * `note-markdown.test.ts` proves the pair of functions round-trips. This
 * proves the editor is actually holding them: that the schema renders what the
 * file says, and that leaving the note writes back everything it rendered.
 * Between the two is where the old bug lived — the converter was reached
 * through the DOM, so what the editor showed and what it saved disagreed.
 */

const RICH = [
  "# Title",
  "",
  "## Section",
  "",
  "Some **bold** and *italic* and `code`.",
  "",
  "- one",
  "  - nested",
  "- two",
  "",
  "1. first",
  "2. second",
  "",
  "> quoted",
  "",
  "---",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "- [ ] open",
  "- [x] done",
  "",
  "Some ==marked== text.",
].join("\n");

function renderPreview(markdown: string, onChange = vi.fn()) {
  const view = render(<NotePreview noteId="note-1" markdown={markdown} onChange={onChange} />);
  const editable = view.container.querySelector(".note-preview") as HTMLElement;
  return { view, editable, onChange };
}

describe("NotePreview", () => {
  it("renders every block the file can hold", () => {
    const { editable } = renderPreview(RICH);

    expect(editable.querySelector("h1")?.textContent).toBe("Title");
    expect(editable.querySelector("h2")?.textContent).toBe("Section");
    expect(editable.querySelector("strong")?.textContent).toBe("bold");
    expect(editable.querySelector("em")?.textContent).toBe("italic");
    expect(editable.querySelector("code")?.textContent).toBe("code");
    expect(editable.querySelector("ul ul li")?.textContent).toBe("nested");
    expect(editable.querySelectorAll("ol > li")).toHaveLength(2);
    expect(editable.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(editable.querySelector("hr")).not.toBeNull();
    expect(editable.querySelector("pre code")?.textContent).toBe("const a = 1;");

    const boxes = editable.querySelectorAll<HTMLInputElement>(
      'ul[data-type="taskList"] input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(2);
    expect([...boxes].map((box) => box.checked)).toEqual([false, true]);
    expect(editable.querySelector("mark")?.textContent).toBe("marked");
  });

  it("keeps a ticked box ticked through a round trip", () => {
    const { editable, onChange } = renderPreview("- [x] done\n- [ ] open");
    fireEvent.blur(editable);
    expect(onChange.mock.calls[0][1]).toBe("- [x] done\n- [ ] open");
  });

  it("writes back on blur everything it rendered", () => {
    const { editable, onChange } = renderPreview(RICH);
    fireEvent.blur(editable);

    expect(onChange).toHaveBeenCalledTimes(1);
    const [noteId, markdown] = onChange.mock.calls[0];
    expect(noteId).toBe("note-1");
    expect(markdown).toBe(RICH);
  });

  it("does not flatten a nested list, which is what the DOM walk used to do", () => {
    const nested = "- one\n  - nested\n    - deeper\n- two";
    const { editable, onChange } = renderPreview(nested);
    fireEvent.blur(editable);
    expect(onChange.mock.calls[0][1]).toBe(nested);
    expect(editable.querySelectorAll("ul")).toHaveLength(3);
  });

  it("keeps heading levels apart instead of collapsing them onto one", () => {
    const { editable, onChange } = renderPreview("# One\n\n## Two\n\n### Three");
    expect(editable.querySelectorAll("h1")).toHaveLength(1);
    expect(editable.querySelectorAll("h2")).toHaveLength(1);
    expect(editable.querySelectorAll("h3")).toHaveLength(1);
    fireEvent.blur(editable);
    expect(onChange.mock.calls[0][1]).toBe("# One\n\n## Two\n\n### Three");
  });

  it("has no underline mark, because the file cannot hold one", () => {
    const { editable, onChange } = renderPreview("some text");
    // StarterKit binds Cmd-U by default. With the mark out of the schema the
    // shortcut is inert, rather than applying formatting that vanishes on blur.
    fireEvent.keyDown(editable, { key: "u", metaKey: true });
    fireEvent.keyDown(editable, { key: "u", ctrlKey: true });
    fireEvent.blur(editable);
    expect(editable.querySelector("u")).toBeNull();
    expect(onChange.mock.calls[0][1]).toBe("some text");
  });

  it("trims trailing whitespace, which markdown cannot hold", () => {
    const { editable, onChange } = renderPreview("a line   ");
    fireEvent.blur(editable);
    expect(onChange.mock.calls[0][1]).toBe("a line");
  });

  it("shows the placeholder on an empty note", () => {
    renderPreview("");
    expect(screen.getByLabelText("Generated note")).toBeTruthy();
  });

  it("tags the write with the note the editor was created under", () => {
    const onChange = vi.fn();
    const view = render(<NotePreview noteId="note-a" markdown="alpha" onChange={onChange} />);
    const editable = view.container.querySelector(".note-preview") as HTMLElement;
    fireEvent.blur(editable);
    expect(onChange).toHaveBeenCalledWith("note-a", "alpha");
  });
});
