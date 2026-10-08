// Deliverables (ADR-0090): the `subrosa:file` block a made document renders
// as, on both shells, and what its buttons ask Rust for.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), mobile: false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/mobile", () => ({ isMobilePlatform: () => mocks.mobile }));

import { FileCard } from "../components/chat-blocks/FileCard";
import {
  chatBlocksToClipboardText,
  parseChatBlock,
  resolveChatBlockFence,
} from "../lib/chat-blocks";
import { type FileChatBlock, parseFilePayload, suggestedFileName } from "../lib/file-block";

const FILE = "0b7c1d2e-1111-4222-8333-444455556666.pptx";

function block(): FileChatBlock {
  return {
    kind: "file",
    file: FILE,
    title: "Board deck",
    documentKind: "pptx",
    detail: "5 slides",
  };
}

beforeEach(() => {
  mocks.mobile = false;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "deliverable_path") return `/gallery/documents/${FILE}`;
    if (command === "carpe_diem_media_export_artifact") return "/Users/me/Board deck.pptx";
    return undefined;
  });
});

describe("the subrosa:file block", () => {
  it("parses what make_document writes and nothing looser", () => {
    const body = JSON.stringify({
      v: 1,
      file: FILE,
      title: "Board deck",
      kind: "pptx",
      detail: "5 slides",
    });
    expect(parseChatBlock("subrosa:file", body)).toEqual(block());
    expect(resolveChatBlockFence("subrosa:file", body, true, false)).toEqual({
      type: "card",
      block: block(),
    });
    for (const file of [
      "../secret.pptx",
      "/Users/me/deck.pptx",
      "0b7c1d2e-1111-4222-8333-444455556666.exe",
      "deck.pptx",
    ]) {
      expect(parseFilePayload({ v: 1, file, title: "x" })).toBeNull();
    }
    // The kind is the file's own.
    expect(parseFilePayload({ v: 1, file: FILE, kind: "docx" })).toBeNull();
    expect(parseFilePayload({ v: 1, file: FILE })?.title).toBe(FILE);
  });

  it("copies as the file's name and suggests a safe one to save as", () => {
    const text = `Here it is:\n\n\`\`\`subrosa:file\n${JSON.stringify({ v: 1, file: FILE, title: "Board deck" })}\n\`\`\``;
    expect(chatBlocksToClipboardText(text)).toBe("Here it is:\n\nBoard deck.pptx");
    expect(suggestedFileName({ ...block(), title: 'Q3: "final" / v2' })).toBe("Q3 final v2.pptx");
  });

  it("opens and saves a copy on the computer", async () => {
    render(<FileCard block={block()} />);
    expect(screen.getByText("PowerPoint deck, 5 slides")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("deliverable_open", { request: { file: FILE } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("carpe_diem_media_export_artifact", {
        request: { path: `/gallery/documents/${FILE}`, suggestedName: "Board deck.pptx" },
      }),
    );
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("shares on the phone, and says when it fails", async () => {
    mocks.mobile = true;
    mocks.invoke.mockRejectedValueOnce({
      code: "deliverable_missing",
      message: "The file could not be found.",
    });
    render(<FileCard block={block()} />);
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share or save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The file could not be found.");
    expect(mocks.invoke).toHaveBeenCalledWith("deliverable_open", { request: { file: FILE } });
  });
});
