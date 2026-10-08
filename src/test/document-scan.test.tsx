import { getSchema } from "@tiptap/react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../src-tauri/src/scan/escape_fixtures.json";
import { noteSchemaExtensions } from "../components/note-editor/extensions";
import { ChatComposer } from "../components/mobile/ChatComposer";
import { ImportSheet } from "../components/mobile/ImportSheet";
import { docToMarkdown, markdownToDoc } from "../lib/note-markdown";
import { scanDocument, scanTitle, supportsDocumentScan, useScanPdf } from "../lib/scan";
import type { AgentLiteAttachment } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  platform: vi.fn(() => "ios"),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: mocks.platform }));
vi.mock("../lib/tauri", () => ({
  mobileDictationStart: vi.fn(),
  mobileDictationStop: vi.fn(),
}));
// The import sheet's link field has its own suite; here it is only a neighbour.
vi.mock("../components/notes-list/ImportLinkBar", () => ({ ImportLinkBar: () => null }));
vi.mock("../lib/haptics", () => ({
  hapticImpact: vi.fn(),
  hapticNotify: vi.fn(),
  hapticSelection: vi.fn(),
}));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.platform.mockReset();
  mocks.platform.mockReturnValue("ios");
});

/**
 * Rust writes a scanned note's body (`src-tauri/src/scan/mod.rs`), and the
 * note editor reads it. The fixture is asserted on both sides: Rust checks it
 * escapes each raw line into `escaped`, and this checks the note's own parser
 * reads `escaped` back as exactly the raw line, and its serializer writes the
 * raw line as exactly `escaped`. A scanned `- 12 €` stays a line of text.
 */
describe("a scanned line survives the note's markdown", () => {
  const schema = getSchema(noteSchemaExtensions());
  for (const { raw, escaped } of fixtures) {
    it(JSON.stringify(raw), () => {
      const doc = markdownToDoc(escaped);
      expect(doc.content).toHaveLength(1);
      expect(doc.content?.[0].type).toBe("paragraph");
      const text = (doc.content?.[0].content ?? []).map((node) => node.text ?? "").join("");
      expect(text).toBe(raw);
      const written = docToMarkdown(
        schema.nodeFromJSON({
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: raw }] }],
        }),
      );
      expect(written).toBe(escaped);
    });
  }

  it("keeps a scanned paragraph's lines as line breaks", () => {
    const doc = markdownToDoc("## Page 1\n\n12 rue des Lilas\n\\- 75011 Paris");
    expect(doc.content?.map((node) => node.type)).toEqual(["heading", "paragraph"]);
    expect(doc.content?.[1].content?.map((node) => node.type)).toEqual([
      "text",
      "hardBreak",
      "text",
    ]);
    expect(doc.content?.[1].content?.[2].text).toBe("- 75011 Paris");
  });
});

describe("the scan facade", () => {
  it("is offered only on a phone", () => {
    expect(supportsDocumentScan()).toBe(true);
    mocks.platform.mockReturnValue("android");
    expect(supportsDocumentScan()).toBe(true);
    mocks.platform.mockReturnValue("macos");
    expect(supportsDocumentScan()).toBe(false);
    mocks.platform.mockImplementation(() => {
      throw new Error("not in tauri");
    });
    expect(supportsDocumentScan()).toBe(false);
  });

  it("names the note and its pages in the reader's words", async () => {
    mocks.invoke.mockResolvedValue(null);
    await expect(scanDocument()).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("document_scan", {
      request: { title: scanTitle(), pageHeading: "Page {n}" },
    });
    expect(scanTitle(new Date(2026, 9, 8))).toMatch(/^Scan of .*2026/);
  });

  it("asks whether a note still has its PDF", async () => {
    mocks.invoke.mockResolvedValue(true);
    const { result } = renderHook(() => useScanPdf("n1"));
    await waitFor(() => expect(result.current).toBe(true));
    expect(mocks.invoke).toHaveBeenCalledWith("document_scan_pdf_exists", { noteId: "n1" });
  });

  it("does not ask on a desktop", () => {
    mocks.platform.mockReturnValue("macos");
    const { result } = renderHook(() => useScanPdf("n1"));
    expect(result.current).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("where a scan starts", () => {
  it("the import sheet offers it when the device has a document camera", async () => {
    const onScan = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <ImportSheet
        onScan={onScan}
        onChooseFile={vi.fn()}
        onCompleted={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Scan a document" }));
    expect(onScan).toHaveBeenCalledTimes(1);
    unmount();
    render(<ImportSheet onChooseFile={vi.fn()} onCompleted={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Scan a document" })).toBeNull();
  });

  function renderComposer(onError: (message: string) => void) {
    let attachments: AgentLiteAttachment[] = [];
    render(
      <ChatComposer
        draft=""
        onDraftChange={vi.fn()}
        attachments={[]}
        onAttachmentsChange={(update) => {
          attachments = typeof update === "function" ? update(attachments) : update;
        }}
        placeholder="Ask"
        canSend
        onSend={vi.fn()}
        onError={onError}
      />,
    );
    return () => attachments;
  }

  it("the chat attaches the scan's text to the turn", async () => {
    mocks.invoke.mockResolvedValue({ noteId: "n1", pages: 2, text: "Invoice 42\n\nTotal due" });
    const onError = vi.fn();
    const user = userEvent.setup();
    const attachments = renderComposer(onError);
    await user.click(screen.getByRole("button", { name: "Scan a document" }));
    await waitFor(() => expect(attachments()).toHaveLength(1));
    expect(attachments()[0]).toEqual({
      kind: "text",
      name: scanTitle(),
      data: "Invoice 42\n\nTotal due",
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("the chat says so when the pages held no text, and attaches nothing", async () => {
    mocks.invoke.mockResolvedValue({ noteId: "n1", pages: 1, text: "  " });
    const onError = vi.fn();
    const user = userEvent.setup();
    const attachments = renderComposer(onError);
    await user.click(screen.getByRole("button", { name: "Scan a document" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(attachments()).toHaveLength(0);
  });

  it("a closed camera attaches nothing and says nothing", async () => {
    mocks.invoke.mockResolvedValue(null);
    const onError = vi.fn();
    const user = userEvent.setup();
    const attachments = renderComposer(onError);
    await user.click(screen.getByRole("button", { name: "Scan a document" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("document_scan", expect.anything()),
    );
    expect(attachments()).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("the desktop composer has no scan button", () => {
    mocks.platform.mockReturnValue("macos");
    renderComposer(vi.fn());
    expect(screen.queryByRole("button", { name: "Scan a document" })).toBeNull();
  });
});
