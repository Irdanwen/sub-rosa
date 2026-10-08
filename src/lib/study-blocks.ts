/**
 * Study chat blocks — `subrosa:quiz` and `subrosa:flashcards` (ADR-0024,
 * ADR-0089).
 *
 * Study mode asks the assistant to check understanding with a quiz and to
 * help memorise with flashcards. Both travel in the reply like every other
 * chat block and are validated as untrusted model output (the parsing is
 * `@subrosa/chat-core/study-blocks`, shared with the web client): nothing
 * throws, strings and lists are capped, a choice question whose answer is
 * not one of its options is dropped rather than shown with a wrong key, and
 * a payload with nothing usable returns null so the call site shows the
 * ordinary code block.
 */

import type { FlashcardsChatBlock, QuizChatBlock } from "@subrosa/chat-core/study-blocks";
import { t } from "./i18n";

export {
  isRightShortAnswer,
  MAX_FLASHCARDS,
  MAX_QUIZ_OPTIONS,
  MAX_QUIZ_QUESTIONS,
  normalizeAnswer,
  parseFlashcardsPayload,
  parseQuizPayload,
} from "@subrosa/chat-core/study-blocks";
export type {
  Flashcard,
  FlashcardsChatBlock,
  QuizChatBlock,
  QuizQuestion,
} from "@subrosa/chat-core/study-blocks";

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
