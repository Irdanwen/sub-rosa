import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasHost } from "../components/canvas/CanvasHost";
import { CanvasPane } from "../components/canvas/CanvasPane";
import { CanvasCard } from "../components/chat-blocks/CanvasCard";
import {
  canvasMarkdown,
  codeFence,
  codeOfCanvas,
  OPEN_CANVAS_EVENT,
  type OpenCanvasDetail,
  openCanvasBlock,
  openReplyInCanvas,
} from "../lib/canvas";
import { chatBlocksToClipboardText, parseChatBlock } from "../lib/chat-blocks";
import type { NoteRewriteRequest } from "../lib/tauri";

/**
 * The canvas (ADR-0087): a note opened beside the chat, and the one rule that
 * matters about what the assistant writes into it: **nothing reaches the note
 * without a click**. Every proposal is shown, then accepted or discarded.
 */

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));

const backend = vi.hoisted(() => ({
  notes: new Map<string, { id: string; title: string; editedContent?: string }>(),
  created: 0,
  updates: [] as { noteId: string; title?: string; editedContent?: string }[],
  rewrites: [] as NoteRewriteRequest[],
  reply: "",
}));

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();
  return {
    ...actual,
    createNote: async () => {
      backend.created += 1;
      const note = { id: `note-${backend.created}`, title: "" };
      backend.notes.set(note.id, note);
      return note;
    },
    getNote: async (noteId: string) => {
      const note = backend.notes.get(noteId);
      if (!note) throw new Error("Note not found.");
      return note;
    },
    updateNote: async (input: { noteId: string; title?: string; editedContent?: string }) => {
      backend.updates.push(input);
      const note = backend.notes.get(input.noteId);
      if (note) {
        if (input.title !== undefined) note.title = input.title;
        if (input.editedContent !== undefined) note.editedContent = input.editedContent;
      }
      return note;
    },
    noteRewrite: async (request: NoteRewriteRequest) => {
      backend.rewrites.push(request);
      return { requestId: request.requestId, text: backend.reply, promptVersion: "test" };
    },
    cancelNoteRewrite: async () => {},
  };
});

beforeEach(() => {
  backend.notes.clear();
  backend.created = 0;
  backend.updates = [];
  backend.rewrites = [];
  backend.reply = "";
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fence(payload: unknown) {
  return JSON.stringify(payload);
}

function captureOpens() {
  const opened: OpenCanvasDetail[] = [];
  const listener = (event: Event) => opened.push((event as CustomEvent<OpenCanvasDetail>).detail);
  window.addEventListener(OPEN_CANVAS_EVENT, listener);
  return { opened, stop: () => window.removeEventListener(OPEN_CANVAS_EVENT, listener) };
}

describe("the subrosa:canvas block", () => {
  it("parses a document and a code canvas", () => {
    expect(
      parseChatBlock(
        "subrosa:canvas",
        fence({ v: 1, title: "Launch plan", kind: "document", content: "# Plan\n\n- ship" }),
      ),
    ).toEqual({
      kind: "canvas",
      title: "Launch plan",
      canvasKind: "document",
      content: "# Plan\n\n- ship",
    });
    expect(
      parseChatBlock(
        "subrosa:canvas",
        fence({ v: 1, title: "fizz", kind: "code", language: "TypeScript", content: "let a = 1;" }),
      ),
    ).toMatchObject({ canvasKind: "code", language: "typescript" });
  });

  it("refuses an empty or oversize draft, and drops a malformed note id or language", () => {
    expect(parseChatBlock("subrosa:canvas", fence({ v: 1, title: "x", content: "  " }))).toBeNull();
    expect(
      parseChatBlock("subrosa:canvas", fence({ v: 1, content: "a".repeat(24_001) })),
    ).toBeNull();
    const block = parseChatBlock(
      "subrosa:canvas",
      fence({
        v: 1,
        kind: "code",
        language: "bash; rm -rf",
        content: "echo hi",
        noteId: "../../etc",
      }),
    );
    expect(block).toMatchObject({ kind: "canvas", canvasKind: "code" });
    expect(block).not.toHaveProperty("language");
    expect(block).not.toHaveProperty("noteId");
  });

  it("titles an untitled draft from its first line", () => {
    expect(
      parseChatBlock("subrosa:canvas", fence({ v: 1, content: "## Weekly update\n\nAll good." })),
    ).toMatchObject({ title: "Weekly update" });
  });

  it("copies as its title and its draft, not as JSON", () => {
    const reply = [
      "Here is the draft.",
      "```subrosa:canvas",
      fence({ v: 1, title: "Note", kind: "code", language: "py", content: "print(1)" }),
      "```",
    ].join("\n");
    expect(chatBlocksToClipboardText(reply)).toBe(
      ["Here is the draft.", "Note", "", "```py", "print(1)", "```"].join("\n"),
    );
  });
});

describe("a code canvas is a note that is one code block", () => {
  it("round-trips through the note's markdown", () => {
    const markdown = canvasMarkdown({
      canvasKind: "code",
      language: "rust",
      content: "fn main() {}",
    });
    expect(markdown).toBe("```rust\nfn main() {}\n```");
    expect(codeOfCanvas(markdown)).toEqual({ code: "fn main() {}", language: "rust" });
  });

  it("fences code that itself holds a fence", () => {
    const code = "```\ninner\n```";
    expect(codeOfCanvas(codeFence(code, "md"))).toEqual({ code, language: "md" });
  });

  it("is not a code canvas once there is prose around the code", () => {
    expect(codeOfCanvas("Intro\n\n```js\nx\n```")).toBeNull();
  });
});

describe("opening a canvas", () => {
  it("makes one note for a block, and goes back to it the second time", async () => {
    const { opened, stop } = captureOpens();
    const block = {
      kind: "canvas" as const,
      title: "Letter",
      canvasKind: "document" as const,
      content: "Dear Ana,",
    };
    const first = await openCanvasBlock(block);
    const second = await openCanvasBlock(block);
    stop();
    expect(first).toBe(second);
    expect(backend.created).toBe(1);
    expect(backend.updates[0]).toEqual({
      noteId: first,
      title: "Letter",
      editedContent: "Dear Ana,",
    });
    expect(opened).toEqual([{ noteId: first }, { noteId: first }]);
  });

  it("opens a block naming an existing canvas as a proposal, never applied", async () => {
    backend.notes.set("canvas-1", { id: "canvas-1", title: "Plan", editedContent: "old" });
    const { opened, stop } = captureOpens();
    await openCanvasBlock({
      kind: "canvas",
      title: "Plan",
      canvasKind: "document",
      content: "new",
      noteId: "canvas-1",
    });
    stop();
    expect(opened).toEqual([{ noteId: "canvas-1", proposal: "new" }]);
    expect(backend.updates).toEqual([]);
    expect(backend.notes.get("canvas-1")?.editedContent).toBe("old");
  });

  it("opens a reply with its cards as plain lists", async () => {
    const { opened, stop } = captureOpens();
    const noteId = await openReplyInCanvas({
      text: "## Summary\n\nDone.",
      conversationId: "chat",
      messageId: "m1",
    });
    stop();
    expect(opened).toEqual([{ noteId }]);
    expect(backend.updates[0]).toMatchObject({
      title: "Summary",
      editedContent: "## Summary\n\nDone.",
    });
  });
});

describe("the canvas card", () => {
  it("offers to open a new draft, and to review a proposed version", async () => {
    const { opened, stop } = captureOpens();
    const { rerender } = render(
      <CanvasCard
        block={{ kind: "canvas", title: "Plan", canvasKind: "code", language: "go", content: "x" }}
      />,
    );
    expect(screen.getByText("Code, go")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open in canvas" }));
    await waitFor(() => expect(opened).toHaveLength(1));

    backend.notes.set("c1", { id: "c1", title: "Plan" });
    rerender(
      <CanvasCard
        block={{
          kind: "canvas",
          title: "Plan",
          canvasKind: "document",
          content: "y",
          noteId: "c1",
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Review in canvas" }));
    await waitFor(() => expect(opened.at(-1)).toEqual({ noteId: "c1", proposal: "y" }));
    stop();
  });
});

describe("the canvas pane", () => {
  it("shows a proposal instead of the document, and writes it only on Accept", async () => {
    backend.notes.set("c1", { id: "c1", title: "Plan", editedContent: "Old plan." });
    render(<CanvasPane noteId="c1" proposal="New plan." layout="split" onClose={() => {}} />);
    expect(await screen.findByText("New plan.")).toBeInTheDocument();
    expect(screen.getByText("Proposed version")).toBeInTheDocument();
    expect(backend.updates).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(backend.updates).toEqual([{ noteId: "c1", editedContent: "New plan." }]);
    expect(screen.queryByText("Proposed version")).not.toBeInTheDocument();
  });

  it("leaves the note alone when a proposal is discarded", async () => {
    backend.notes.set("c1", { id: "c1", title: "Plan", editedContent: "Old plan." });
    render(<CanvasPane noteId="c1" proposal="New plan." layout="split" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(backend.updates).toEqual([]);
    expect(await screen.findByRole("textbox", { name: "Generated note" })).toHaveTextContent(
      "Old plan.",
    );
  });

  it("sends the whole document and the instruction as a canvas edit", async () => {
    backend.notes.set("c1", { id: "c1", title: "Plan", editedContent: "# Plan\n\nShip it." });
    backend.reply = "# Plan\n\nShip it on Friday.";
    render(<CanvasPane noteId="c1" layout="split" onClose={() => {}} />);
    await screen.findByRole("textbox", { name: "Generated note" });
    await userEvent.type(screen.getByRole("textbox", { name: "Ask for a change" }), "add the day");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(backend.rewrites).toHaveLength(1));
    expect(backend.rewrites[0]).toMatchObject({
      kind: "canvas",
      text: "# Plan\n\nShip it.",
      instruction: "add the day",
    });
    expect(await screen.findByText(/Ship it on Friday\./)).toBeInTheDocument();
    expect(backend.updates).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(backend.updates).toEqual([
      { noteId: "c1", editedContent: "# Plan\n\nShip it on Friday." },
    ]);
  });

  it("names a code canvas and copies the code alone", async () => {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    backend.notes.set("c1", { id: "c1", title: "Script", editedContent: "```sh\necho hi\n```" });
    render(<CanvasPane noteId="c1" layout="screen" onClose={() => {}} />);
    expect(await screen.findByText("Code, sh")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("echo hi");
  });
});

describe("the desktop split view", () => {
  it("opens the canvas beside the chat without remounting the chat", async () => {
    backend.notes.set("c1", { id: "c1", title: "Plan", editedContent: "Text." });
    let mounts = 0;
    function Chat() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <p>chat</p>;
    }
    const { container } = render(
      <CanvasHost>
        <Chat />
      </CanvasHost>,
    );
    expect(container.querySelector(".canvas-split")).not.toHaveAttribute("data-open");
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CANVAS_EVENT, { detail: { noteId: "c1" } }));
    });
    expect(container.querySelector(".canvas-split")).toHaveAttribute("data-open");
    expect(await screen.findByRole("region", { name: "Canvas" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close canvas" }));
    expect(screen.queryByRole("region", { name: "Canvas" })).not.toBeInTheDocument();
    expect(mounts).toBe(1);
  });
});
