/**
 * The study blocks in a reply (ADR-0089): a quiz answered in place and never
 * stored, and flashcards that flip and can be added to the review. The
 * payload is parsed by the shared parser (`@subrosa/chat-core/study-blocks`)
 * as untrusted model output; every value is written as text through React.
 */
import {
  type FlashcardsChatBlock,
  isRightShortAnswer,
  parseFlashcardsPayload,
  parseQuizPayload,
  type QuizChatBlock,
} from "@subrosa/chat-core/study-blocks";
import { useState } from "react";
import { t } from "../../lib/i18n";
import type { BlockProps } from "../feature";
import { addCards } from "./cards";
import "./study.css";

type Answer = { right: boolean; given: string };

function Quiz({ block }: { block: QuizChatBlock }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [typed, setTyped] = useState("");
  const question = block.questions[index];
  const answered = answers[index];
  const score = answers.filter((answer) => answer?.right).length;
  const finished = answers.length === block.questions.length && answers.every(Boolean);
  const answer = (right: boolean, given: string) =>
    setAnswers((value) => {
      const next = [...value];
      next[index] = { right, given };
      return next;
    });
  return (
    <section className="chat-block study-card" data-kind="quiz">
      <h3>{block.title || t("Quiz", "Quiz")}</h3>
      {finished ? (
        <p role="status">
          {t(
            `Score: ${score} of ${block.questions.length}.`,
            `Score : ${score} sur ${block.questions.length}.`,
          )}
        </p>
      ) : (
        <p className="quiet">
          {t(
            `Question ${index + 1} of ${block.questions.length}`,
            `Question ${index + 1} sur ${block.questions.length}`,
          )}
        </p>
      )}
      <p>
        <strong>{question.prompt}</strong>
      </p>
      {question.kind === "choice" ? (
        <div className="study-options">
          {question.options.map((option, optionIndex) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: the options of a question never move.
              key={`${optionIndex}-${option}`}
              type="button"
              className="button"
              disabled={!!answered}
              aria-pressed={answered?.given === String(optionIndex)}
              onClick={() => answer(optionIndex === question.answer, String(optionIndex))}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="wc-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!typed.trim() || answered) return;
            answer(isRightShortAnswer(question, typed), typed);
            setTyped("");
          }}
        >
          <label className="sr-only" htmlFor={`quiz-${index}`}>
            {t("Your answer", "Votre réponse")}
          </label>
          <input
            id={`quiz-${index}`}
            value={answered ? answered.given : typed}
            disabled={!!answered}
            onChange={(event) => setTyped(event.target.value)}
          />
          <button className="button" type="submit" disabled={!!answered || !typed.trim()}>
            {t("Check", "Vérifier")}
          </button>
        </form>
      )}
      {answered && (
        <div role="status">
          <p>
            {answered.right
              ? t("Right.", "Juste.")
              : question.kind === "choice"
                ? t(
                    `Not quite. The answer is: ${question.options[question.answer]}`,
                    `Pas tout à fait. La réponse est : ${question.options[question.answer]}`,
                  )
                : t(
                    `Not quite. The answer is: ${question.answer}`,
                    `Pas tout à fait. La réponse est : ${question.answer}`,
                  )}
          </p>
          {question.explanation && <p className="quiet">{question.explanation}</p>}
        </div>
      )}
      <div className="wc-row">
        <button
          type="button"
          className="button"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          {t("Previous", "Précédente")}
        </button>
        <button
          type="button"
          className="button"
          disabled={index >= block.questions.length - 1}
          onClick={() => setIndex(index + 1)}
        >
          {t("Next", "Suivante")}
        </button>
      </div>
    </section>
  );
}

function Flashcards({ block, host }: { block: FlashcardsChatBlock; host: BlockProps["host"] }) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [status, setStatus] = useState("");
  const card = block.cards[index];
  const add = async () => {
    try {
      const result = await addCards(host.storeFor("study"), block.cards, {
        deck: block.title,
        chatId: host.openChatId,
      });
      setStatus(
        result.added === 0
          ? t(
              "These cards are already in your review.",
              "Ces cartes sont déjà dans votre révision.",
            )
          : t(
              `${result.added} cards added to your review.`,
              `${result.added} cartes ajoutées à votre révision.`,
            ),
      );
    } catch {
      setStatus(t("These cards could not be added.", "Ces cartes n’ont pas pu être ajoutées."));
    }
  };
  return (
    <section className="chat-block study-card" data-kind="flashcards">
      <h3>{block.title || t("Flashcards", "Fiches")}</h3>
      <p className="quiet">
        {t(
          `Card ${index + 1} of ${block.cards.length}`,
          `Fiche ${index + 1} sur ${block.cards.length}`,
        )}
      </p>
      <button
        type="button"
        className="study-flip"
        aria-pressed={flipped}
        onClick={() => setFlipped((value) => !value)}
      >
        <span className="quiet">{flipped ? t("Back", "Verso") : t("Front", "Recto")}</span>
        <strong>{flipped ? card.back : card.front}</strong>
      </button>
      <div className="wc-row">
        <button
          type="button"
          className="button"
          disabled={index === 0}
          onClick={() => {
            setIndex(index - 1);
            setFlipped(false);
          }}
        >
          {t("Previous", "Précédente")}
        </button>
        <button
          type="button"
          className="button"
          disabled={index >= block.cards.length - 1}
          onClick={() => {
            setIndex(index + 1);
            setFlipped(false);
          }}
        >
          {t("Next", "Suivante")}
        </button>
        <button type="button" className="button primary" onClick={() => void add()}>
          {t("Add to review", "Ajouter à la révision")}
        </button>
      </div>
      {status && (
        <p className="quiet" role="status">
          {status}
        </p>
      )}
    </section>
  );
}

/** A block whose payload has nothing usable falls back to the plain list
 * (`undefined` would, but a component must render something). */
export function QuizBlock({ payload }: BlockProps) {
  const block = parseQuizPayload(payload);
  return block ? <Quiz block={block} /> : <MissingBlock />;
}
export function FlashcardsBlock({ payload, host }: BlockProps) {
  const block = parseFlashcardsPayload(payload);
  return block ? <Flashcards block={block} host={host} /> : <MissingBlock />;
}

function MissingBlock() {
  return (
    <p className="chat-block chat-block-missing">
      {t("This study block could not be read.", "Ce bloc d’étude n’a pas pu être lu.")}
    </p>
  );
}
