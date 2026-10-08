// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import exported from "@subrosa/chat-core/web/study.json";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FeatureHost, featureStore } from "../../website/src/client/feature";
import { memoryClientStore } from "../../website/src/client/store";
import { FlashcardsBlock, QuizBlock } from "../../website/src/client/study/blocks";
import {
  addCards,
  cardKey,
  dueCards,
  reviewCard,
  setStudyChat,
  studyStats,
} from "../../website/src/client/study/cards";
import { resetStudyTab, studyFeature } from "../../website/src/client/study";
import { ReviewPanel } from "../../website/src/client/study/ReviewPanel";
import { type CardState, type Grade, review, STUDY } from "../../website/src/client/study/schedule";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  vi.unstubAllGlobals();
  resetStudyTab();
});

const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";

function host() {
  const store = memoryClientStore();
  const key = new Uint8Array(32).fill(7);
  return {
    storeFor: (feature: string) => featureStore(ACCOUNT, key, store, feature),
    openChatId: "chat-1",
  } as unknown as FeatureHost;
}

describe("SM-2 in the browser", () => {
  const vectors = (
    exported as unknown as {
      vectors: {
        now: string;
        reviews: { state: CardState; grade: Grade; next: CardState; due: string }[];
      };
    }
  ).vectors;

  it("answers what Rust answers for every card and grade", () => {
    const now = new Date(vectors.now);
    expect(vectors.reviews.length).toBe(20);
    for (const vector of vectors.reviews) {
      const { next, due } = review(vector.state, vector.grade, now);
      expect(next.intervalDays).toBe(vector.next.intervalDays);
      expect(next.repetitions).toBe(vector.next.repetitions);
      expect(next.lapses).toBe(vector.next.lapses);
      expect(next.ease).toBeCloseTo(vector.next.ease, 9);
      expect(due.toISOString()).toBe(vector.due);
    }
  });
});

describe("the review store", () => {
  it("adds a card once, due now, and schedules it by the answer", async () => {
    const store = host().storeFor("study");
    const now = new Date("2026-10-01T09:00:00.000Z");
    expect(await cardKey("  The   Capital ", "PARIS")).toBe(await cardKey("the capital", "paris"));
    const first = await addCards(
      store,
      [
        { front: "Capital of France", back: "Paris" },
        { front: "Capital of Italy", back: "Rome" },
        { front: " ", back: "nothing" },
      ],
      { deck: "Geography" },
      now,
    );
    expect(first).toEqual({ added: 2, already: 0 });
    expect(
      await addCards(store, [{ front: "capital  of france", back: "paris" }], {}, now),
    ).toEqual({ added: 0, already: 1 });
    await expect(addCards(store, [], {}, now)).rejects.toThrow();
    await expect(
      addCards(
        store,
        Array.from({ length: STUDY.maxCardsPerAdd + 1 }, (_, n) => ({ front: `${n}`, back: "x" })),
        {},
        now,
      ),
    ).rejects.toThrow();

    const due = await dueCards(store, now);
    expect(due).toHaveLength(2);
    expect(due[0].deck).toBe("Geography");
    const reviewed = await reviewCard(store, due[0].id, "good", now);
    expect(reviewed.intervalDays).toBe(1);
    expect(reviewed.dueAt).toBe("2026-10-02T09:00:00.000Z");
    expect(await studyStats(store, now)).toEqual({
      total: 2,
      due: 1,
      nextDueAt: "2026-10-02T09:00:00.000Z",
    });
  });
});

describe("study mode", () => {
  it("adds the tutoring prompt only to a chat in study mode", async () => {
    const fake = host();
    const turn = (chatId: string | null, temporary = false) =>
      studyFeature.turn?.(fake, { chatId, temporary, question: "Teach me" });
    expect(await turn("chat-1")).toBeNull();
    await setStudyChat(fake.storeFor("study"), "chat-1", true);
    expect(await turn("chat-1")).toEqual({ tools: [], prompt: STUDY.prompt });
    expect(STUDY.prompt).toContain("subrosa:quiz");
    expect(await turn("chat-2")).toBeNull();
    expect(await turn(null, true)).toBeNull();
  });

  it("carries the choice made on a new chat to the chat its first turn creates", async () => {
    const fake = host();
    const user = userEvent.setup();
    const Toggle = studyFeature.ComposerControl;
    if (!Toggle) throw new Error("no toggle");
    render(
      <Toggle host={fake} chatId={null} temporary={false} draft="" setDraft={() => undefined} />,
    );
    await user.click(await screen.findByRole("button", { name: "Study mode" }));
    expect(screen.getByRole("button", { name: "Study mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const addition = await studyFeature.turn?.(fake, {
      chatId: "new-chat",
      temporary: false,
      question: "Teach me",
    });
    expect(addition?.prompt).toBe(STUDY.prompt);
    expect(
      await studyFeature.turn?.(fake, { chatId: "other", temporary: false, question: "x" }),
    ).toBeNull();
  });
});

describe("the study blocks", () => {
  it("asks a quiz in place, with feedback and the score", async () => {
    const user = userEvent.setup();
    render(
      <QuizBlock
        host={host()}
        messageId="m"
        payload={{
          v: 1,
          title: "Capitals",
          questions: [
            {
              kind: "choice",
              prompt: "Capital of France?",
              options: ["Lyon", "Paris"],
              answer: 1,
              explanation: "Paris since 987.",
            },
            { kind: "short", prompt: "Capital of Italy?", answer: "Rome", accept: ["Roma"] },
          ],
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Lyon" }));
    expect(screen.getByText("Not quite. The answer is: Paris")).toBeInTheDocument();
    expect(screen.getByText("Paris since 987.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Your answer"), " roma ");
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(screen.getByText("Right.")).toBeInTheDocument();
    expect(screen.getByText("Score: 1 of 2.")).toBeInTheDocument();
  });

  it("flips flashcards and adds them to the review", async () => {
    const user = userEvent.setup();
    const fake = host();
    render(
      <FlashcardsBlock
        host={fake}
        messageId="m"
        payload={{
          v: 1,
          title: "Capitals",
          cards: [
            { front: "France", back: "Paris" },
            { front: "Italy", back: "Rome" },
          ],
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /France/ }));
    expect(screen.getByRole("button", { name: /Paris/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Add to review" }));
    expect(await screen.findByText("2 cards added to your review.")).toBeInTheDocument();
    const cards = await dueCards(fake.storeFor("study"));
    expect(cards.map((card) => card.front).sort()).toEqual(["France", "Italy"]);
    expect(cards[0].chatId).toBe("chat-1");
  });

  it("falls back to a quiet line for a block with nothing usable", () => {
    render(<QuizBlock host={host()} messageId="m" payload={{ v: 1, questions: [] }} />);
    expect(screen.getByText("This study block could not be read.")).toBeInTheDocument();
  });
});

describe("the review panel", () => {
  it("shows a due card, then its answer, and schedules it", async () => {
    const user = userEvent.setup();
    const fake = host();
    await addCards(fake.storeFor("study"), [{ front: "France", back: "Paris" }]);
    render(<ReviewPanel host={fake} />);
    expect(await screen.findByText("France")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the answer" }));
    expect(screen.getByText("Paris")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Good" }));
    expect(await screen.findByText(/Nothing due until/)).toBeInTheDocument();
  });
});
