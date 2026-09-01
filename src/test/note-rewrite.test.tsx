import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotePreview } from "../components/note-editor/NotePreview";
import type { NoteRewriteRequest } from "../lib/tauri";

/**
 * The revision, and the one rule that matters about it: **nothing reaches the
 * note without a click** (ADR-0038).
 *
 * Every case here ends by reading what the editor would save. A rewrite that
 * fails, is discarded, or is still running must leave that string exactly as
 * it was — the failure mode of an assistant inside a document is not that it
 * refuses, it is that it changed something quietly.
 */

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("../lib/mobile", () => ({ isMobilePlatform: () => mobile.value }));

const backend = vi.hoisted(() => ({
  calls: [] as NoteRewriteRequest[],
  cancelled: [] as string[],
  reply: null as null | ((request: NoteRewriteRequest) => Promise<{ text: string }>),
}));

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();
  return {
    ...actual,
    noteRewrite: (request: NoteRewriteRequest) => {
      backend.calls.push(request);
      return (
        backend.reply?.(request) ?? Promise.resolve({ text: "", requestId: request.requestId })
      ).then((result) => ({ ...result, requestId: request.requestId, promptVersion: "test" }));
    },
    cancelNoteRewrite: (requestId: string) => {
      backend.cancelled.push(requestId);
      return Promise.resolve();
    },
  };
});

beforeEach(() => {
  backend.calls = [];
  backend.cancelled = [];
  backend.reply = null;
  mobile.value = true; // the docked toolbar is reachable without a mouse selection
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPreview(markdown: string) {
  const onChange = vi.fn();
  const view = render(<NotePreview noteId="n1" markdown={markdown} onChange={onChange} />);
  const editable = view.container.querySelector(".note-preview") as HTMLElement;
  return { view, editable, onChange };
}

function selectBlock(editable: HTMLElement, index = 0) {
  editable.focus();
  fireEvent.focus(editable);
  const range = document.createRange();
  range.selectNodeContents(editable.children[index]);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function savedMarkdown(editable: HTMLElement, onChange: ReturnType<typeof vi.fn>) {
  fireEvent.blur(editable);
  return onChange.mock.calls.at(-1)?.[1] as string;
}

async function openRewrite(view: ReturnType<typeof render>, label: string) {
  fireEvent.click(await screen.findByLabelText("Rewrite"));
  fireEvent.click(within(view.container).getByRole("menuitem", { name: new RegExp(label, "i") }));
}

describe("starting a rewrite", () => {
  it("offers the kinds, and marks the two that need something typed", async () => {
    const { view, editable } = renderPreview("hello");
    selectBlock(editable);
    fireEvent.click(await screen.findByLabelText("Rewrite"));

    const items = within(view.container)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      "Correct spelling and grammar",
      "Reformulate",
      "Make it shorter",
      "Develop it",
      "Reorganise",
      "Translate to…",
      "Do something else…",
    ]);
  });

  it("hands the model markdown, not the bare text", async () => {
    const { view, editable } = renderPreview("- one\n- two");
    selectBlock(editable);
    await openRewrite(view, "Reorganise");

    await waitFor(() => expect(backend.calls).toHaveLength(1));
    expect(backend.calls[0].kind).toBe("restructure");
    // The prompts promise to keep the structure; they cannot keep what they
    // were never shown.
    expect(backend.calls[0].text).toBe("- one\n- two");
  });

  it("asks for a target language before translating", async () => {
    const { view, editable } = renderPreview("bonjour");
    selectBlock(editable);
    await openRewrite(view, "Translate to");

    expect(backend.calls).toHaveLength(0);
    await userEvent.type(screen.getByLabelText("Translate to"), "Italian");
    fireEvent.click(within(view.container).getByText("Go"));

    await waitFor(() => expect(backend.calls).toHaveLength(1));
    expect(backend.calls[0]).toMatchObject({ kind: "translate", targetLanguage: "Italian" });
  });

  it("asks what to do before a free rewrite", async () => {
    const { view, editable } = renderPreview("some notes");
    selectBlock(editable);
    await openRewrite(view, "Do something else");
    await userEvent.type(screen.getByLabelText("Do something else"), "turn it into a checklist");
    fireEvent.click(within(view.container).getByText("Go"));

    await waitFor(() => expect(backend.calls).toHaveLength(1));
    expect(backend.calls[0]).toMatchObject({
      kind: "custom",
      instruction: "turn it into a checklist",
    });
  });
});

describe("a revision reaches the note only on a gesture", () => {
  it("changes nothing while it is running", async () => {
    let resolve: (value: { text: string }) => void = () => undefined;
    backend.reply = () => new Promise((r) => (resolve = r));

    const { view, editable, onChange } = renderPreview("original text");
    selectBlock(editable);
    await openRewrite(view, "Reformulate");
    await waitFor(() => expect(backend.calls).toHaveLength(1));

    expect(editable.textContent).toBe("original text");
    resolve({ text: "rewritten text" });
    await screen.findByText("Replace");
    // Ready, shown, and still not applied.
    expect(editable.textContent).toBe("original text");
    expect(savedMarkdown(editable, onChange)).toBe("original text");
  });

  it("replaces on Replace, in a single undo step", async () => {
    backend.reply = async () => ({ text: "rewritten text" });
    const { view, editable, onChange } = renderPreview("original text");
    selectBlock(editable);
    await openRewrite(view, "Reformulate");

    fireEvent.click(await screen.findByText("Replace"));
    expect(savedMarkdown(editable, onChange)).toBe("rewritten text");

    // One press, not two: applying a revision is a single transaction.
    // Ctrl rather than Cmd because prosemirror-keymap resolves `Mod` from
    // `navigator.platform`, which jsdom leaves empty.
    fireEvent.keyDown(editable, { key: "z", ctrlKey: true });
    expect(savedMarkdown(editable, onChange)).toBe("original text");
  });

  it("keeps the original when asked to insert below", async () => {
    backend.reply = async () => ({ text: "Ciao a tutti" });
    const { view, editable, onChange } = renderPreview("Bonjour à tous");
    selectBlock(editable);
    await openRewrite(view, "Reformulate");

    fireEvent.click(await screen.findByText("Insert below"));
    expect(savedMarkdown(editable, onChange)).toBe("Bonjour à tous\n\nCiao a tutti");
  });

  it("leaves the note untouched when the model fails", async () => {
    backend.reply = async () => {
      throw new Error("upstream is having a moment");
    };
    const { view, editable, onChange } = renderPreview("original text");
    selectBlock(editable);
    await openRewrite(view, "Reformulate");

    await screen.findByText(/upstream is having a moment/i);
    expect(screen.queryByText("Replace")).toBeNull();
    expect(savedMarkdown(editable, onChange)).toBe("original text");
  });

  it("leaves the note untouched when the revision is discarded", async () => {
    backend.reply = async () => ({ text: "rewritten text" });
    const { view, editable, onChange } = renderPreview("original text");
    selectBlock(editable);
    await openRewrite(view, "Reformulate");

    fireEvent.click(await screen.findByLabelText("Discard"));
    expect(savedMarkdown(editable, onChange)).toBe("original text");
    // And it stops paying for whatever was still in flight.
    expect(backend.cancelled).toHaveLength(1);
  });

  it("stops a run that is taking too long", async () => {
    backend.reply = () => new Promise(() => undefined);
    const { view, editable } = renderPreview("original text");
    selectBlock(editable);
    await openRewrite(view, "Reorganise");

    fireEvent.click(await screen.findByText("Stop"));
    expect(backend.cancelled).toEqual([backend.calls[0].requestId]);
  });
});

describe("what a revision replaces", () => {
  it("follows the passage when the note is edited while the model works", async () => {
    let resolve: (value: { text: string }) => void = () => undefined;
    backend.reply = () => new Promise((r) => (resolve = r));

    const { view, editable, onChange } = renderPreview("first line\n\nsecond line");
    // Rewrite the *second* paragraph.
    selectBlock(editable, 1);
    await openRewrite(view, "Reformulate");
    await waitFor(() => expect(backend.calls).toHaveLength(1));
    expect(backend.calls[0].text).toBe("second line");

    // Now split the first paragraph, which shifts everything after it. Enter
    // goes through ProseMirror's own keymap, so this is a real transaction
    // rather than a DOM mutation jsdom would never surface.
    const first = editable.firstElementChild as HTMLElement;
    const caret = document.createRange();
    caret.setStart(first.firstChild as Text, 5);
    caret.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(editable.querySelectorAll("p")).toHaveLength(3);

    resolve({ text: "rewritten second" });
    fireEvent.click(await screen.findByText("Replace"));

    // Exact, not "contains": a range that drifted by the two positions the
    // split inserted would still land inside the target paragraph and replace
    // most of it, which a loose assertion cannot tell from success.
    expect(savedMarkdown(editable, onChange)).toBe("first\n\n line\n\nrewritten second");
  });

  it("does not split a paragraph when only part of it was selected", async () => {
    backend.reply = async () => ({ text: "corrected" });
    const { view, editable, onChange } = renderPreview("before wrong after");

    editable.focus();
    fireEvent.focus(editable);
    const paragraph = editable.firstElementChild as HTMLElement;
    const textNode = paragraph.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 7);
    range.setEnd(textNode, 12);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    await openRewrite(view, "Correct spelling and grammar");
    fireEvent.click(await screen.findByText("Replace"));

    expect(savedMarkdown(editable, onChange)).toBe("before corrected after");
    expect(editable.querySelectorAll("p")).toHaveLength(1);
  });

  it("inserts real structure as structure, even from inside a paragraph", async () => {
    backend.reply = async () => ({ text: "## Plan\n\n- [ ] first\n- [ ] second" });
    const { view, editable, onChange } = renderPreview("do the thing");
    selectBlock(editable);
    await openRewrite(view, "Reorganise");
    fireEvent.click(await screen.findByText("Replace"));

    expect(savedMarkdown(editable, onChange)).toBe("## Plan\n\n- [ ] first\n- [ ] second");
  });

  it("puts a structured reply beside the list rather than inside the checkbox", async () => {
    backend.reply = async () => ({ text: "## Plan\n\n- [ ] first" });
    const { view, editable, onChange } = renderPreview("- [ ] rework this\n- [ ] leave me alone");

    // Select inside the first item's text only.
    editable.focus();
    fireEvent.focus(editable);
    const paragraph = editable.querySelector("li p") as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    await openRewrite(view, "Reorganise");
    fireEvent.click(await screen.findByText("Replace"));

    const saved = savedMarkdown(editable, onChange);
    // The heading is at the top level, not buried under a checkbox with the
    // whole document indented beneath it, which is what replacing only the
    // item's paragraph produced.
    expect(saved).toMatch(/^## Plan$/m);
    // The text that was rewritten is gone...
    expect(saved).not.toContain("rework this");
    // ...and the neighbour, which the model never saw, is untouched.
    expect(saved).toContain("leave me alone");
  });
});
