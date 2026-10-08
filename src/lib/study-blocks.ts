/**
 * Study chat blocks — `subrosa:quiz` and `subrosa:flashcards` (ADR-0024,
 * ADR-0089).
 *
 * Study mode asks the assistant to check understanding with a quiz and to
 * help memorise with flashcards. Both travel in the reply like every other
 * chat block and are validated here as untrusted model output: nothing
 * throws, strings and lists are capped, a choice question whose answer is
 * not one of its options is dropped rather than shown with a wrong key, and
 * a payload with nothing usable returns null so the call site shows the
 * ordinary code block.
 */

import { t } from "./i18n";

export type QuizQuestion =
  | {
      kind: "choice";
      prompt: string;
      options: string[];
      /** Index into `options`. */
      answer: number;
      explanation?: string;
    }
  | {
      kind: "short";
      prompt: string;
      answer: string;
      /** Other answers that count as right. */
      accept: string[];
      explanation?: string;
    };

export type QuizChatBlock = {
  kind: "quiz";
  title?: string;
  questions: QuizQuestion[];
};

export type Flashcard = { front: string; back: string };

export type FlashcardsChatBlock = {
  kind: "flashcards";
  title?: string;
  cards: Flashcard[];
};

export const MAX_QUIZ_QUESTIONS = 10;
export const MAX_QUIZ_OPTIONS = 6;
export const MAX_FLASHCARDS = 30;
const MAX_TITLE = 120;
const MAX_PROMPT = 600;
const MAX_OPTION = 240;
const MAX_EXPLANATION = 1_200;
const MAX_SIDE = 600;

function capped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseQuestion(entry: unknown): QuizQuestion | null {
  const item = asObject(entry);
  if (!item) return null;
  const prompt = capped(item.prompt, MAX_PROMPT);
  if (!prompt) return null;
  const explanation = capped(item.explanation, MAX_EXPLANATION);
  if (item.kind === "short") {
    const answer = capped(item.answer, MAX_OPTION);
    if (!answer) return null;
    const accept = Array.isArray(item.accept)
      ? item.accept
          .map((value) => capped(value, MAX_OPTION))
          .filter((value): value is string => Boolean(value))
          .slice(0, 8)
      : [];
    return { kind: "short", prompt, answer, accept, ...(explanation ? { explanation } : {}) };
  }
  if (!Array.isArray(item.options)) return null;
  const raw = item.options.slice(0, MAX_QUIZ_OPTIONS).map((value) => capped(value, MAX_OPTION));
  // An option the model left empty would shift every index after it; refuse
  // the question rather than mark the wrong option right.
  if (raw.some((value) => !value)) return null;
  const options = raw as string[];
  const answer = item.answer;
  if (
    options.length < 2 ||
    typeof answer !== "number" ||
    !Number.isInteger(answer) ||
    answer < 0 ||
    answer >= options.length
  ) {
    return null;
  }
  return { kind: "choice", prompt, options, answer, ...(explanation ? { explanation } : {}) };
}

/** Parses a `subrosa:quiz` payload (already JSON-decoded, `v` checked). */
export function parseQuizPayload(payload: Record<string, unknown>): QuizChatBlock | null {
  if (!Array.isArray(payload.questions)) return null;
  const questions = payload.questions
    .slice(0, MAX_QUIZ_QUESTIONS)
    .map(parseQuestion)
    .filter((question): question is QuizQuestion => question !== null);
  if (questions.length === 0) return null;
  const title = capped(payload.title, MAX_TITLE);
  return { kind: "quiz", ...(title ? { title } : {}), questions };
}

/** Parses a `subrosa:flashcards` payload (already JSON-decoded, `v` checked). */
export function parseFlashcardsPayload(
  payload: Record<string, unknown>,
): FlashcardsChatBlock | null {
  if (!Array.isArray(payload.cards)) return null;
  const cards: Flashcard[] = [];
  for (const entry of payload.cards) {
    if (cards.length >= MAX_FLASHCARDS) break;
    const item = asObject(entry);
    const front = capped(item?.front, MAX_SIDE);
    const back = capped(item?.back, MAX_SIDE);
    if (front && back) cards.push({ front, back });
  }
  if (cards.length === 0) return null;
  const title = capped(payload.title, MAX_TITLE);
  return { kind: "flashcards", ...(title ? { title } : {}), cards };
}

/** How a short answer is compared: case, accents, spacing and final
 * punctuation do not count. */
export function normalizeAnswer(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s.,;:!?'"«»()]+/g, " ")
    .trim();
}

export function isRightShortAnswer(
  question: Extract<QuizQuestion, { kind: "short" }>,
  given: string,
): boolean {
  const normalized = normalizeAnswer(given);
  if (!normalized) return false;
  return [question.answer, ...question.accept].some(
    (answer) => normalizeAnswer(answer) === normalized,
  );
}

/** The blocks as plain text, for copying a reply. */
export function quizPlainText(block: QuizChatBlock): string[] {
  const lines = [block.title || t("Quiz")];
  block.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.prompt}`);
    if (question.kind === "choice") {
      question.options.forEach((option, optionIndex) => {
        lines.push(`   ${String.fromCharCode(97 + optionIndex)}) ${option}`);
      });
    }
  });
  return lines;
}

export function flashcardsPlainText(block: FlashcardsChatBlock): string[] {
  return [
    block.title || t("Flashcards"),
    ...block.cards.map((card) => `- ${card.front}: ${card.back}`),
  ];
}
