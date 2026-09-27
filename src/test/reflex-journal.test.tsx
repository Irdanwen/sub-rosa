import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReflexJournalCard,
  ReflexJournalGroup,
  changeSentence,
} from "../components/settings/ReflexJournal";
import type { AutonomousChangeDto } from "../lib/reflex";

const mocks = vi.hoisted(() => ({ reflexJournal: vi.fn(), reflexUndo: vi.fn() }));

vi.mock("../lib/reflex", () => ({
  reflexJournal: mocks.reflexJournal,
  reflexUndo: mocks.reflexUndo,
}));

function change(overrides: Partial<AutonomousChangeDto> = {}): AutonomousChangeDto {
  return {
    id: "c1",
    kind: "memory_update",
    subjectId: "m1",
    before: { text: "Habite à Paris.", disabled: false },
    after: { text: "Habite à Lyon.", disabled: false },
    probability: 0.97,
    createdAt: "2026-09-27T10:00:00Z",
    undoneAt: null,
    ...overrides,
  };
}

describe("changeSentence", () => {
  it("says what each kind of change did", () => {
    expect(changeSentence(change())).toBe("Replaced “Habite à Paris.” with “Habite à Lyon.”");
    expect(
      changeSentence(
        change({
          kind: "memory_same",
          before: { text: "Aime le café.", disabled: false },
          after: { text: "Boit du café.", disabled: false },
        }),
      ),
    ).toBe("Did not store “Aime le café.”, already known as “Boit du café.”");
    expect(changeSentence(change({ kind: "memory_forget" }))).toBe(
      "Paused “Habite à Paris.”, which a newer fact made untrue",
    );
  });
});

describe("the journal of changes", () => {
  beforeEach(() => {
    mocks.reflexJournal.mockReset();
    mocks.reflexUndo.mockReset();
  });

  it("undoes a change and shows it undone, on the desktop", async () => {
    mocks.reflexJournal.mockResolvedValue([change()]);
    mocks.reflexUndo.mockResolvedValue(change({ undoneAt: "2026-09-27T11:00:00Z" }));
    render(<ReflexJournalCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mocks.reflexUndo).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("Undone")).toBeInTheDocument();
  });

  it("says why an undo was refused, on the phone", async () => {
    mocks.reflexJournal.mockResolvedValue([change()]);
    mocks.reflexUndo.mockRejectedValue({
      code: "reflex_change_moved",
      message: "This memory changed since, so it was left as it is.",
    });
    render(<ReflexJournalGroup />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText(/changed since/)).toBeInTheDocument();
  });

  it("is absent while there is nothing in it", async () => {
    mocks.reflexJournal.mockResolvedValue([]);
    const { container } = render(<ReflexJournalCard />);
    await waitFor(() => expect(mocks.reflexJournal).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
