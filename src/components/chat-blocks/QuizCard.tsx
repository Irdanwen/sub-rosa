import "../../styles/study-research.css";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useId, useState } from "react";
import { t } from "../../lib/i18n";
import { isRightShortAnswer, type QuizChatBlock, type QuizQuestion } from "../../lib/study-blocks";

type Answer = { given: string; right: boolean };

/**
 * A quiz from study mode (`subrosa:quiz`). Each question is answered in
 * place: an option for a choice, a few words for a short answer. The card
 * says at once whether it was right, shows the explanation, and keeps the
 * score. Nothing is stored; answering again starts over.
 */
export function QuizCard({ block }: { block: QuizChatBlock }) {
  const [answers, setAnswers] = useState<(Answer | null)[]>(() => block.questions.map(() => null));
  const [round, setRound] = useState(0);
  const answered = answers.filter((answer): answer is Answer => answer !== null);
  const score = answered.filter((answer) => answer.right).length;
  const title = block.title || t("Quiz");
  const record = (index: number, answer: Answer) =>
    setAnswers((current) => current.map((entry, i) => (i === index ? answer : entry)));

  return (
    <section className="chat-block study-quiz" aria-label={title}>
      <h4 className="chat-block-title">{title}</h4>
      <ol className="study-quiz-questions">
        {block.questions.map((question, index) => (
          <QuizQuestionView
            // A new round remounts every question, so typed answers clear too.
            // biome-ignore lint/suspicious/noArrayIndexKey: questions are positional and never reorder
            key={`${round}-${index}`}
            question={question}
            number={index + 1}
            answer={answers[index]}
            onAnswer={(answer) => record(index, answer)}
          />
        ))}
      </ol>
      <footer className="study-quiz-footer">
        <span role="status">
          {answered.length === block.questions.length
            ? t("Score: {score} of {total}", { score, total: block.questions.length })
            : t("{answered} of {total} answered", {
                answered: answered.length,
                total: block.questions.length,
              })}
        </span>
        {answered.length > 0 ? (
          <button
            type="button"
            className="study-button"
            onClick={() => {
              setAnswers(block.questions.map(() => null));
              setRound((current) => current + 1);
            }}
          >
            {t("Start over")}
          </button>
        ) : null}
      </footer>
    </section>
  );
}

function QuizQuestionView({
  question,
  number,
  answer,
  onAnswer,
}: {
  question: QuizQuestion;
  number: number;
  answer: Answer | null;
  onAnswer: (answer: Answer) => void;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  return (
    <li className="study-quiz-question">
      <p className="study-quiz-prompt">
        <span className="study-quiz-number">{number}.</span> {question.prompt}
      </p>
      {question.kind === "choice" ? (
        <div className="study-quiz-options">
          {question.options.map((option, index) => {
            const chosen = answer?.given === String(index);
            const state = !answer
              ? undefined
              : index === question.answer
                ? "right"
                : chosen
                  ? "wrong"
                  : undefined;
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: options are positional
                key={index}
                type="button"
                className="study-quiz-option"
                data-state={state}
                aria-pressed={chosen}
                disabled={answer !== null}
                onClick={() => onAnswer({ given: String(index), right: index === question.answer })}
              >
                {state === "right" ? <IconCheckmark1Small size={16} aria-hidden /> : null}
                {state === "wrong" ? <IconCrossSmall size={16} aria-hidden /> : null}
                <span>{option}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <form
          className="study-quiz-short"
          onSubmit={(event) => {
            event.preventDefault();
            if (!typed.trim() || answer) return;
            onAnswer({ given: typed, right: isRightShortAnswer(question, typed) });
          }}
        >
          <label className="study-visually-hidden" htmlFor={inputId}>
            {t("Your answer")}
          </label>
          <input
            id={inputId}
            className="study-input"
            value={typed}
            disabled={answer !== null}
            placeholder={t("Your answer")}
            onChange={(event) => setTyped(event.target.value)}
          />
          <button type="submit" className="study-button" disabled={!typed.trim() || !!answer}>
            {t("Check")}
          </button>
        </form>
      )}
      {answer ? (
        <div className="study-quiz-feedback" data-right={answer.right || undefined}>
          <p>
            {answer.right
              ? t("Right.")
              : question.kind === "short"
                ? t("Not quite. The answer is {answer}.", { answer: question.answer })
                : t("Not quite. The answer is {answer}.", {
                    answer: question.options[question.answer],
                  })}
          </p>
          {question.explanation ? <p>{question.explanation}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
