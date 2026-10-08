import "../../styles/study-research.css";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconFlashcards } from "central-icons/IconFlashcards";
import { useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { addStudyCards } from "../../lib/study";
import type { FlashcardsChatBlock } from "../../lib/study-blocks";

/**
 * Flashcards from study mode (`subrosa:flashcards`): one card at a time, a
 * tap turns it over, and "Add to review" keeps the deck for spaced
 * repetition (the Review screen brings each card back when it is due).
 */
export function FlashcardsCard({ block }: { block: FlashcardsChatBlock }) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const title = block.title || t("Flashcards");
  const card = block.cards[index];
  const go = (next: number) => {
    setIndex(next);
    setFlipped(false);
  };

  const add = async () => {
    setAdding(true);
    try {
      const result = await addStudyCards(block.cards, block.title);
      setStatus(
        result.added === 0
          ? t("These cards are already in your review.")
          : result.added === 1
            ? t("1 card added to your review.")
            : t("{count} cards added to your review.", { count: result.added }),
      );
    } catch (err) {
      setStatus(messageFromError(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="chat-block study-flashcards" aria-label={title}>
      <h4 className="chat-block-title">{title}</h4>
      <button
        type="button"
        className="study-flashcard"
        data-flipped={flipped || undefined}
        aria-label={flipped ? t("Show the question") : t("Show the answer")}
        onClick={() => setFlipped((current) => !current)}
      >
        <span className="study-flashcard-side">{flipped ? t("Answer") : t("Question")}</span>
        <span className="study-flashcard-text">{flipped ? card.back : card.front}</span>
      </button>
      <footer className="study-flashcards-footer">
        <button
          type="button"
          className="study-icon-button"
          aria-label={t("Previous card")}
          disabled={index === 0}
          onClick={() => go(index - 1)}
        >
          <IconChevronLeftSmall size={18} />
        </button>
        <span className="study-flashcards-count">
          {t("{index} of {total}", { index: index + 1, total: block.cards.length })}
        </span>
        <button
          type="button"
          className="study-icon-button"
          aria-label={t("Next card")}
          disabled={index >= block.cards.length - 1}
          onClick={() => go(index + 1)}
        >
          <IconChevronRightSmall size={18} />
        </button>
        <span className="study-spacer" />
        <button type="button" className="study-button" disabled={adding} onClick={() => void add()}>
          <IconFlashcards size={16} aria-hidden />
          {t("Add to review")}
        </button>
      </footer>
      {status ? (
        <p className="study-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
