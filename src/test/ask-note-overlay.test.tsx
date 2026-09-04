import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AskNoteOverlay } from "../components/ask/AskNoteOverlay";

const mocks = vi.hoisted(() => ({
  askNotes: vi.fn(),
  askCancel: vi.fn(async () => undefined),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../lib/ask", () => ({
  ASK_EVENT: "june://ask",
  askNotes: mocks.askNotes,
  askCancel: mocks.askCancel,
}));

describe("AskNoteOverlay", () => {
  beforeEach(() => {
    mocks.askNotes.mockReset();
  });

  it("asks for the question first, then answers from this note alone", async () => {
    mocks.askNotes.mockResolvedValue({
      answer: "Monday [1].",
      citations: [{ index: 1, noteId: "n1", title: "Infra sync", kind: "note", excerpt: "Monday" }],
      sent: [{ index: 1, noteId: "n1", title: "Infra sync", kind: "note", excerpt: "Monday" }],
      invented: [],
      promptVersion: 1,
    });
    const onClose = vi.fn();
    render(
      <AskNoteOverlay noteId="n1" title="Infra sync" onOpenNote={() => {}} onClose={onClose} />,
    );
    const input = screen.getByRole("textbox", { name: "Your question" });
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "When is it?" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(mocks.askNotes).toHaveBeenCalledWith("When is it?", expect.any(String), "n1"),
    );
    expect(await screen.findByText(/Monday/)).toBeInTheDocument();
  });

  it("Escape on the prompt closes it", () => {
    const onClose = vi.fn();
    render(<AskNoteOverlay noteId="n1" title="" onOpenNote={() => {}} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Ask this note" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
