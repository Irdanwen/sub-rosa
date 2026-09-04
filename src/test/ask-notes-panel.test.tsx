import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AskNotesPanel, answerParts, looksLikeAQuestion } from "../components/ask/AskNotesPanel";

const mocks = vi.hoisted(() => ({ askNotes: vi.fn() }));

vi.mock("../lib/ask", () => ({ askNotes: mocks.askNotes }));

describe("looksLikeAQuestion", () => {
  it("takes a trailing question mark, or a leading interrogative in either language", () => {
    expect(looksLikeAQuestion("quand migre-t-on le cluster ?")).toBe(true);
    expect(looksLikeAQuestion("What did we decide about pricing")).toBe(true);
    expect(looksLikeAQuestion("Pourquoi le budget a bougé")).toBe(true);
    expect(looksLikeAQuestion("budget")).toBe(false);
    expect(looksLikeAQuestion("Réunion budget 2027")).toBe(false);
    expect(looksLikeAQuestion("is ok?")).toBe(false);
  });
});

describe("answerParts", () => {
  it("turns each known citation into a link and leaves unknown ones as text", () => {
    const citations = [
      { index: 2, noteId: "n2", title: "Two", kind: "note", excerpt: "" },
      { index: 1, noteId: "n1", title: "One", kind: "transcript", excerpt: "" },
    ];
    expect(answerParts("Lundi [2]. Mardi [1] et [9].", citations)).toEqual([
      { text: "Lundi " },
      { citation: citations[0] },
      { text: ". Mardi " },
      { citation: citations[1] },
      { text: " et " },
      { text: "[9]" },
      { text: "." },
    ]);
  });
});

describe("AskNotesPanel", () => {
  beforeEach(() => {
    mocks.askNotes.mockReset();
  });

  it("shows the answer, links citations to notes, and lists what was sent", async () => {
    mocks.askNotes.mockResolvedValue({
      answer: "The migration is on Monday [1]. Budget holds [2].",
      citations: [
        { index: 1, noteId: "n1", title: "Infra sync", kind: "note", excerpt: "Monday…" },
        { index: 2, noteId: "n2", title: "Budget review", kind: "transcript", excerpt: "holds…" },
      ],
      sent: [
        { index: 1, noteId: "n1", title: "Infra sync", kind: "note", excerpt: "Monday…" },
        { index: 2, noteId: "n2", title: "Budget review", kind: "transcript", excerpt: "holds…" },
        { index: 3, noteId: "n3", title: "Offsite", kind: "note", excerpt: "unused…" },
      ],
      invented: [],
      promptVersion: 1,
    });
    const onOpenNote = vi.fn();
    render(
      <AskNotesPanel
        question="When is the migration?"
        onOpenNote={onOpenNote}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Reading your notes");
    expect(await screen.findByText(/The migration is on Monday/)).toBeInTheDocument();
    expect(mocks.askNotes).toHaveBeenCalledWith("When is the migration?");

    fireEvent.click(screen.getByRole("button", { name: /Budget review/ }));
    expect(onOpenNote).toHaveBeenCalledWith("n2");

    fireEvent.click(screen.getByRole("button", { name: "What was sent (3 passages)" }));
    expect(screen.getByText("Offsite")).toBeInTheDocument();
    expect(screen.getByText("unused…")).toBeInTheDocument();
  });

  it("names a citation the model invented instead of hiding it", async () => {
    mocks.askNotes.mockResolvedValue({
      answer: "Nothing certain [4].",
      citations: [],
      sent: [{ index: 1, noteId: "n1", title: "A", kind: "note", excerpt: "a" }],
      invented: [4],
      promptVersion: 1,
    });
    render(<AskNotesPanel question="Is it certain?" onOpenNote={() => {}} onClose={() => {}} />);
    expect(await screen.findByText(/The model cited \[4\]/)).toBeInTheDocument();
  });

  it("shows the failure in words", async () => {
    mocks.askNotes.mockRejectedValue(new Error("The model returned status 503."));
    render(<AskNotesPanel question="Why did it fail?" onOpenNote={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("The model returned status 503.")).toBeInTheDocument();
  });
});
