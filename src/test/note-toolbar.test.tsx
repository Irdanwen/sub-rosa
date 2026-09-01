import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotePreview } from "../components/note-editor/NotePreview";
import { blockPaletteItems } from "../components/note-editor/blockPalette";

/**
 * The writing surface.
 *
 * Two rules are load-bearing and are asserted here rather than assumed:
 * **every control writes something the file can hold** (each case ends by
 * reading the markdown back), and **no control exists for something it
 * cannot** — there is no underline button, because `docToMarkdown` has no
 * underline to write.
 */

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("../lib/mobile", () => ({ isMobilePlatform: () => mobile.value }));

afterEach(() => {
  mobile.value = false;
  vi.restoreAllMocks();
});

function renderPreview(markdown = "hello world") {
  const onChange = vi.fn();
  const view = render(<NotePreview noteId="n1" markdown={markdown} onChange={onChange} />);
  const editable = view.container.querySelector(".note-preview") as HTMLElement;
  return { view, editable, onChange };
}

/**
 * Select the whole first block, which is what makes the toolbar appear.
 *
 * The real `focus()` rather than `fireEvent.focus`: ProseMirror asks
 * `document.activeElement` whether it has focus, and a dispatched focus event
 * does not move that. Without it the view never reads the DOM selection back,
 * and every mark command silently applies to an empty range.
 */
function focusEditor(editable: HTMLElement) {
  editable.focus();
  fireEvent.focus(editable);
}

function selectAll(editable: HTMLElement) {
  focusEditor(editable);
  const range = document.createRange();
  range.selectNodeContents(editable.firstElementChild as HTMLElement);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

/** Collapsed caret at the end of a block, which is what a list command acts on. */
function placeCaret(editable: HTMLElement, block: Element) {
  focusEditor(editable);
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function markdownAfterBlur(editable: HTMLElement, onChange: ReturnType<typeof vi.fn>) {
  fireEvent.blur(editable);
  return onChange.mock.calls.at(-1)?.[1] as string;
}

describe("the selection toolbar", () => {
  it("offers block styles, list kinds, marks and a link, and nothing markdown cannot hold", () => {
    mobile.value = true; // docked mode shows the toolbar without a selection
    const { view, editable } = renderPreview();
    focusEditor(editable);
    const toolbar = view.container.querySelector(".selection-toolbar") as HTMLElement;

    const labels = within(toolbar)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));

    expect(labels).toEqual([
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bullet list",
      "Numbered list",
      "Task list",
      "Bold",
      "Italic",
      "Strikethrough",
      "Highlight",
      "Code",
      "Link",
      "Rewrite",
    ]);
    expect(labels).not.toContain("Underline");
  });

  it.each([
    ["Heading 2", "## hello world"],
    ["Bullet list", "- hello world"],
    ["Numbered list", "1. hello world"],
    ["Task list", "- [ ] hello world"],
    ["Bold", "**hello world**"],
    ["Italic", "*hello world*"],
    ["Strikethrough", "~~hello world~~"],
    ["Highlight", "==hello world=="],
    ["Code", "`hello world`"],
  ])("writes %s back to the file as %s", async (label, expected) => {
    mobile.value = true;
    const { view, editable, onChange } = renderPreview();
    selectAll(editable);
    const toolbar = view.container.querySelector(".selection-toolbar") as HTMLElement;
    fireEvent.click(within(toolbar).getByLabelText(label));
    expect(markdownAfterBlur(editable, onChange)).toBe(expected);
  });

  it("is docked, not floating, on a phone", () => {
    mobile.value = true;
    const { view, editable } = renderPreview();
    focusEditor(editable);
    const toolbar = view.container.querySelector(".selection-toolbar") as HTMLElement;
    expect(toolbar.classList.contains("note-toolbar-docked")).toBe(true);
    // Docked means "pinned above the keyboard", so it carries no caret
    // coordinates at all.
    expect(toolbar.style.left).toBe("");
  });

  it("stays hidden on a pointer device until something is selected", () => {
    const { view, editable } = renderPreview();
    focusEditor(editable);
    expect(view.container.querySelector(".selection-toolbar")).toBeNull();
  });
});

describe("keyboard nesting", () => {
  it("nests a bullet with Tab and lifts it back with Shift-Tab", () => {
    const { editable, onChange } = renderPreview("- one\n- two");
    const items = editable.querySelectorAll("li > p");
    placeCaret(editable, items[1]);

    fireEvent.keyDown(editable, { key: "Tab" });
    expect(markdownAfterBlur(editable, onChange)).toBe("- one\n  - two");

    placeCaret(editable, editable.querySelectorAll("li > p")[1]);
    fireEvent.keyDown(editable, { key: "Tab", shiftKey: true });
    expect(markdownAfterBlur(editable, onChange)).toBe("- one\n- two");
  });

  it("nests a task item too, which needs the nested option to be on", () => {
    const { editable, onChange } = renderPreview("- [ ] one\n- [ ] two");
    placeCaret(editable, editable.querySelectorAll('ul[data-type="taskList"] li p')[1]);
    fireEvent.keyDown(editable, { key: "Tab" });
    expect(markdownAfterBlur(editable, onChange)).toBe("- [ ] one\n  - [ ] two");
  });

  it("splits a list item on Enter rather than breaking out of the list", () => {
    const { editable, onChange } = renderPreview("- one");
    placeCaret(editable, editable.querySelector("li > p") as Element);
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(editable.querySelectorAll("li")).toHaveLength(2);
    expect(markdownAfterBlur(editable, onChange)).toBe("- one\n-");
  });
});

describe("the link field", () => {
  it("opens on the primary shortcut and writes a markdown link", async () => {
    mobile.value = true;
    const { view, editable, onChange } = renderPreview("example");
    selectAll(editable);
    fireEvent.keyDown(editable, { key: "k", metaKey: true });

    const input = await screen.findByLabelText("Link address");
    await userEvent.type(input, "example.com");
    fireEvent.click(within(view.container).getByText("Apply"));

    expect(markdownAfterBlur(editable, onChange)).toBe("[example](https://example.com)");
  });

  it("removes the link when the field is emptied", async () => {
    mobile.value = true;
    const { view, editable, onChange } = renderPreview("[example](https://example.com)");
    selectAll(editable);
    fireEvent.keyDown(editable, { key: "k", metaKey: true });

    const input = await screen.findByLabelText("Link address");
    await userEvent.clear(input);
    fireEvent.click(within(view.container).getByText("Remove"));

    expect(markdownAfterBlur(editable, onChange)).toBe("example");
  });

  it("turns an address that is only a host into https, and an address into mailto", async () => {
    mobile.value = true;
    const { view, editable, onChange } = renderPreview("write");
    selectAll(editable);
    fireEvent.keyDown(editable, { key: "k", metaKey: true });
    const input = await screen.findByLabelText("Link address");
    await userEvent.type(input, "someone@example.com");
    fireEvent.click(within(view.container).getByText("Apply"));
    expect(markdownAfterBlur(editable, onChange)).toBe("[write](mailto:someone@example.com)");
  });
});

describe("what a link is allowed to be", () => {
  it("refuses a scheme a note has no business making clickable", async () => {
    mobile.value = true;
    const { view, editable, onChange } = renderPreview("click");
    selectAll(editable);
    fireEvent.keyDown(editable, { key: "k", metaKey: true });
    const input = await screen.findByLabelText("Link address");
    await userEvent.type(input, "javascript:alert(1)");
    fireEvent.click(within(view.container).getByText("Apply"));
    // Not a link, and the text is untouched.
    expect(markdownAfterBlur(editable, onChange)).toBe("click");
  });
});

describe("the block palette", () => {
  it("lists every block, each labelled with the shortcut that also makes it", () => {
    const items = blockPaletteItems("");
    expect(items.map((item) => item.label)).toEqual([
      "Text",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bullet list",
      "Numbered list",
      "Task list",
      "Quote",
      "Code block",
      "Divider",
    ]);
    expect(items.find((item) => item.label === "Task list")?.hint).toBe("[] ");
    expect(items.find((item) => item.label === "Quote")?.hint).toBe("> ");
  });

  it("matches on the label and on words a person would reach for instead", () => {
    expect(blockPaletteItems("todo").map((item) => item.id)).toEqual(["taskList"]);
    expect(blockPaletteItems("checkbox").map((item) => item.id)).toEqual(["taskList"]);
    expect(blockPaletteItems("separator").map((item) => item.id)).toEqual(["horizontalRule"]);
    expect(blockPaletteItems("head").map((item) => item.id)).toEqual(["h1", "h2", "h3"]);
    expect(blockPaletteItems("zzz")).toEqual([]);
  });
});
