// Study mode (ADR-0089): the composer switch per chat, the draft that
// follows the chat it creates, the desktop's per-message tutoring context,
// and the review that schedules cards.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { ComposerModes } from "../components/agent/ComposerModes";
import { StudyReview } from "../components/study/StudyReview";
import {
  resetStudyModes,
  setStudyMode,
  type StudyCard,
  studyChatStarted,
  studyOn,
  withStudyContext,
} from "../lib/study";

const PROMPT = "Study mode is on. Act as a patient tutor.";

function card(id: string, front: string, back: string): StudyCard {
  return {
    id,
    front,
    back,
    deck: "Capitals",
    ease: 2.5,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    dueAt: "2026-10-08T09:00:00.000Z",
    createdAt: "2026-10-08T09:00:00.000Z",
  };
}

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
const calls: [string, Record<string, unknown>][] = [];

beforeEach(() => {
  resetStudyModes();
  calls.length = 0;
  handlers = {
    study_prompt: () => PROMPT,
    study_mode: (args) => (args.request as { on?: boolean }).on ?? false,
    study_cards_stats: () => ({ total: 0, due: 0, nextDueAt: null }),
    research_list: () => [],
  };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    calls.push([command, args]);
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected ${command}`);
    return handler(args);
  });
  mocks.listen.mockReset();
  mocks.listen.mockResolvedValue(() => undefined);
});

describe("the desktop message in study mode", () => {
  it("carries the tutor after the context marker only while the mode is on", async () => {
    expect(await withStudyContext("Explain entropy", "s1")).toBe("Explain entropy");
    await setStudyMode("s1", true);
    expect(calls).toContainEqual(["study_mode", { request: { chatId: "s1", on: true } }]);
    expect(await withStudyContext("Explain entropy", "s1")).toBe(
      `Explain entropy\n\n--- Attached Context ---\n\n${PROMPT}`,
    );
    // A project's context already opened the marker: the tutor follows it.
    const withProject = "Hi\n\n--- Attached Context ---\n\nProject context: Launch";
    expect(await withStudyContext(withProject, "s1")).toBe(`${withProject}\n\n${PROMPT}`);
    await setStudyMode("s1", false);
    expect(await withStudyContext("Explain entropy", "s1")).toBe("Explain entropy");
  });

  it("follows a draft into the chat it creates", async () => {
    await setStudyMode(undefined, true);
    // The first message of a new chat is sent before the chat has an id.
    expect(await withStudyContext("Teach me", undefined)).toContain(PROMPT);
    expect(calls.some(([command]) => command === "study_mode")).toBe(false);
    await studyChatStarted("new-chat");
    expect(studyOn("new-chat")).toBe(true);
    expect(studyOn(undefined)).toBe(false);
    expect(calls).toContainEqual(["study_mode", { request: { chatId: "new-chat", on: true } }]);
    // A chat started without the draft is left alone.
    calls.length = 0;
    await studyChatStarted("other-chat");
    expect(calls).toHaveLength(0);
  });
});

describe("the composer modes", () => {
  it("switch study mode for the open chat and read it back", async () => {
    handlers.study_mode = (args) => {
      const request = args.request as { chatId: string; on?: boolean };
      return request.on ?? request.chatId === "studying";
    };
    const { rerender } = render(<ComposerModes chatId="plain" draft="" />);
    const toggle = await screen.findByRole("button", { name: "Study" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    expect(calls).toContainEqual(["study_mode", { request: { chatId: "plain", on: true } }]);
    rerender(<ComposerModes chatId="studying" draft="" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Study" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    // No cards yet, so no review button.
    expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
  });

  it("show the cards due and open the research on the draft", async () => {
    handlers.study_cards_stats = () => ({ total: 3, due: 2, nextDueAt: null });
    render(<ComposerModes chatId="c1" draft="  Heat pumps in old houses  " />);
    expect(await screen.findByRole("button", { name: "Review, 2 due" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deep research" }));
    const field = (await screen.findByLabelText(
      "What should be researched?",
    )) as HTMLTextAreaElement;
    expect(field.value).toBe("Heat pumps in old houses");
  });

  it("gather everything behind one button on the phone", async () => {
    render(<ComposerModes chatId="c1" draft="" compact />);
    fireEvent.click(screen.getByRole("button", { name: "Study and research" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn study mode on" }));
    await waitFor(() => expect(studyOn("c1")).toBe(true));
    expect(screen.getByRole("button", { name: "Study mode is on. More modes" })).toBeTruthy();
  });
});

describe("the review", () => {
  it("shows a card, reveals it, schedules it, and brings a lapse back", async () => {
    const queue = [card("a", "Peru", "Lima"), card("b", "Chile", "Santiago")];
    handlers.study_cards_due = () => queue;
    handlers.study_cards_stats = () => ({
      total: 2,
      due: 2,
      nextDueAt: "2026-10-09T09:00:00.000Z",
    });
    handlers.study_card_review = (args) => {
      const { id, grade } = args.request as { id: string; grade: string };
      const original = queue.find((entry) => entry.id === id) as StudyCard;
      return { ...original, repetitions: grade === "again" ? 0 : 1 };
    };
    render(<StudyReview open onClose={() => undefined} />);
    expect(await screen.findByText("Peru")).toBeTruthy();
    expect(screen.getByText("2 cards to review")).toBeTruthy();
    expect(screen.queryByText("Lima")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the answer" }));
    expect(screen.getByText("Lima")).toBeTruthy();
    // Forgotten: it comes back at the end of this sitting.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Again/ }));
    });
    expect(calls).toContainEqual(["study_card_review", { request: { id: "a", grade: "again" } }]);
    expect(await screen.findByText("Chile")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show the answer" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Good/ }));
    });
    expect(await screen.findByText("Peru")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show the answer" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Easy/ }));
    });
    expect(await screen.findByText("You are done for now.")).toBeTruthy();
  });

  it("says how to get cards when there are none", async () => {
    handlers.study_cards_due = () => [];
    render(<StudyReview open onClose={() => undefined} />);
    expect(
      await screen.findByText("Add flashcards from a study chat to review them here."),
    ).toBeTruthy();
  });
});
