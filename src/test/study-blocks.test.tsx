// Study mode's chat blocks (ADR-0089): `subrosa:quiz` and
// `subrosa:flashcards` go through the shared parser like every other card,
// refuse what they cannot show honestly, render in the shared markdown, and
// the flashcards hand their deck to the review.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: (path: string) => path,
}));

import { ChatBlockView } from "../components/chat-blocks/ChatBlockView";
import { chatBlocksToClipboardText, parseChatBlock } from "../lib/chat-blocks";
import { SimpleMarkdown } from "../lib/simple-markdown";
import {
  type FlashcardsChatBlock,
  isRightShortAnswer,
  normalizeAnswer,
  type QuizChatBlock,
} from "../lib/study-blocks";

const QUIZ = {
  v: 1,
  title: "Photosynthesis",
  questions: [
    {
      kind: "choice",
      prompt: "Where does photosynthesis happen?",
      options: ["Mitochondria", "Chloroplasts", "Nucleus"],
      answer: 1,
      explanation: "Chloroplasts hold the chlorophyll.",
    },
    {
      kind: "short",
      prompt: "Which gas do plants take in?",
      answer: "Carbon dioxide",
      accept: ["CO2"],
    },
  ],
};

const CARDS = {
  v: 1,
  title: "Capitals",
  cards: [
    { front: "Peru", back: "Lima" },
    { front: "Chile", back: "Santiago" },
  ],
};

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe("parsing study blocks", () => {
  it("reads a quiz and a deck, and degrades what it cannot show", () => {
    const quiz = parseChatBlock("subrosa:quiz", JSON.stringify(QUIZ)) as QuizChatBlock;
    expect(quiz.kind).toBe("quiz");
    expect(quiz.questions).toHaveLength(2);
    expect(quiz.questions[1]).toMatchObject({ kind: "short", accept: ["CO2"] });

    // An answer that is not one of the options, an empty option that would
    // shift the key, or a single option: the question is dropped.
    const broken = parseChatBlock(
      "subrosa:quiz",
      JSON.stringify({
        v: 1,
        questions: [
          { kind: "choice", prompt: "a?", options: ["x", "y"], answer: 2 },
          { kind: "choice", prompt: "b?", options: ["x", "", "z"], answer: 2 },
          { kind: "choice", prompt: "c?", options: ["x"], answer: 0 },
          { kind: "choice", prompt: "d?", options: ["x", "y"], answer: 0.5 },
        ],
      }),
    );
    expect(broken).toBeNull();
    expect(parseChatBlock("subrosa:quiz", '{"v":2,"questions":[]}')).toBeNull();

    const deck = parseChatBlock("subrosa:flashcards", JSON.stringify(CARDS)) as FlashcardsChatBlock;
    expect(deck.cards).toEqual(CARDS.cards);
    const capped = parseChatBlock(
      "subrosa:flashcards",
      JSON.stringify({
        v: 1,
        cards: [
          ...Array.from({ length: 40 }, (_, i) => ({ front: `q${i}`, back: "a" })),
          { front: "no back" },
        ],
      }),
    ) as FlashcardsChatBlock;
    expect(capped.cards).toHaveLength(30);
    expect(parseChatBlock("subrosa:flashcards", '{"v":1,"cards":[{"front":"x"}]}')).toBeNull();
  });

  it("copies as readable text", () => {
    const text = [
      "Let us check.",
      "```subrosa:quiz",
      JSON.stringify(QUIZ),
      "```",
      "```subrosa:flashcards",
      JSON.stringify(CARDS),
      "```",
    ].join("\n");
    expect(chatBlocksToClipboardText(text)).toBe(
      [
        "Let us check.",
        "Photosynthesis",
        "1. Where does photosynthesis happen?",
        "   a) Mitochondria",
        "   b) Chloroplasts",
        "   c) Nucleus",
        "2. Which gas do plants take in?",
        "Capitals",
        "- Peru: Lima",
        "- Chile: Santiago",
      ].join("\n"),
    );
  });

  it("compares short answers without case, accents or punctuation", () => {
    const question = (parseChatBlock("subrosa:quiz", JSON.stringify(QUIZ)) as QuizChatBlock)
      .questions[1];
    if (question.kind !== "short") throw new Error("expected a short answer");
    expect(normalizeAnswer("  Éléphant ! ")).toBe("elephant");
    expect(isRightShortAnswer(question, "carbon DIOXIDE.")).toBe(true);
    expect(isRightShortAnswer(question, "co2")).toBe(true);
    expect(isRightShortAnswer(question, "oxygen")).toBe(false);
    expect(isRightShortAnswer(question, "   ")).toBe(false);
  });
});

describe("the quiz card", () => {
  it("marks answers, explains, and keeps the score", () => {
    render(<SimpleMarkdown text={`\`\`\`subrosa:quiz\n${JSON.stringify(QUIZ)}\n\`\`\``} />);
    expect(screen.getByText("0 of 2 answered")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mitochondria" }));
    expect(screen.getByText("Not quite. The answer is Chloroplasts.")).toBeTruthy();
    expect(screen.getByText("Chloroplasts hold the chlorophyll.")).toBeTruthy();
    // Answered once: the options are settled.
    expect((screen.getByRole("button", { name: "Nucleus" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByPlaceholderText("Your answer"), { target: { value: "CO2" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(screen.getByText("Right.")).toBeTruthy();
    expect(screen.getByText("Score: 1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByText("0 of 2 answered")).toBeTruthy();
    expect((screen.getByPlaceholderText("Your answer") as HTMLInputElement).value).toBe("");
  });
});

describe("the flashcards card", () => {
  it("flips, steps through the deck, and adds it to the review", async () => {
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "study_cards_add") {
        expect(args).toEqual({
          request: { cards: CARDS.cards, deck: "Capitals", chatId: undefined },
        });
        return { added: 2, already: 0 };
      }
      throw new Error(`unexpected ${command}`);
    });
    const block = parseChatBlock("subrosa:flashcards", JSON.stringify(CARDS));
    if (!block) throw new Error("expected a deck");
    render(<ChatBlockView block={block} />);
    expect(screen.getByText("Peru")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show the answer" }));
    expect(screen.getByText("Lima")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next card" }));
    expect(screen.getByText("Chile")).toBeTruthy();
    expect(screen.getByText("2 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
    await waitFor(() => expect(screen.getByText("2 cards added to your review.")).toBeTruthy());
  });

  it("says when the deck is already in the review", async () => {
    mocks.invoke.mockResolvedValue({ added: 0, already: 2 });
    const block = parseChatBlock("subrosa:flashcards", JSON.stringify(CARDS));
    if (!block) throw new Error("expected a deck");
    render(<ChatBlockView block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
    await waitFor(() =>
      expect(screen.getByText("These cards are already in your review.")).toBeTruthy(),
    );
  });
});
