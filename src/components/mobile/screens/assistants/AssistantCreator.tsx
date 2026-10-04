// The guided way to a new assistant on the phone: the idea, then one question
// per screen with its answers as chips, then a drafted assistant opened in the
// editor. Every answer is kept on the device as it is given, so leaving for
// another tab, or the phone dropping the app, loses nothing.

import { useEffect, useRef, useState } from "react";
import { emptyAssistant, prepareAssistantDraft } from "../../../../lib/assistants";
import {
  type CreatorDraft,
  clearCreatorDraft,
  readCreatorDraft,
  writeCreatorDraft,
  writeEditorDraft,
} from "../../../../lib/assistant-draft";
import { messageFromError } from "../../../../lib/errors";
import { hapticImpact, hapticSelection } from "../../../../lib/haptics";
import { t } from "../../../../lib/i18n";
import { useKeyboardInset } from "../../../../lib/keyboard-inset";
import { assistantQuestions } from "../../../assistants/templates";
import { Spinner } from "../../../ui/Spinner";
import { StackHeader } from "../../StackHeader";

const START: CreatorDraft = { idea: "", step: -1, answers: {}, freeAnswers: {} };

export function AssistantCreator({
  initialIdea,
  onBack,
  onDrafted,
  onWriteMyself,
}: {
  /** A template's idea: starts over from it. */
  initialIdea?: string;
  onBack: () => void;
  /** The drafted assistant is waiting in the editor's new draft. */
  onDrafted: () => void;
  onWriteMyself: () => void;
}) {
  const [state, setState] = useState<CreatorDraft>(() => {
    if (initialIdea !== undefined) return { ...START, idea: initialIdea };
    return readCreatorDraft() ?? START;
  });
  const [restored, setRestored] = useState(
    () => initialIdea === undefined && Boolean(readCreatorDraft()?.idea.trim()),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyboardInset = useKeyboardInset();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const questions = assistantQuestions();
  const question = state.step >= 0 ? questions[state.step] : undefined;
  const last = state.step === questions.length - 1;

  useEffect(() => {
    if (state.idea.trim() || state.step >= 0) writeCreatorDraft(state);
  }, [state]);

  const patch = (value: Partial<CreatorDraft>) => setState((current) => ({ ...current, ...value }));

  const toggle = (option: string) => {
    if (!question) return;
    hapticSelection();
    setState((current) => {
      const chosen = current.answers[question.id] ?? [];
      const next =
        question.type === "single"
          ? chosen.includes(option)
            ? []
            : [option]
          : chosen.includes(option)
            ? chosen.filter((value) => value !== option)
            : [...chosen, option];
      return { ...current, answers: { ...current.answers, [question.id]: next } };
    });
  };

  const draft = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await prepareAssistantDraft(
        state.idea,
        questions.map((entry) => ({
          question: entry.label,
          answer: [...(state.answers[entry.id] ?? []), state.freeAnswers[entry.id] ?? ""]
            .filter((value) => value.trim())
            .join("; "),
        })),
      );
      writeEditorDraft("", {
        baseRevision: 0,
        drafted: true,
        definition: {
          ...emptyAssistant(),
          name: result.name,
          description: result.description,
          instructions: result.instructions,
          opening_message: result.openingMessage,
          tools: result.tools,
        },
      });
      clearCreatorDraft();
      // Left while the draft was being written (a swipe back, another tab):
      // it waits in the editor's new draft, and nothing navigates from here,
      // since the shell would move whichever tab is now in front.
      if (!mounted.current) return;
      hapticImpact("light");
      onDrafted();
    } catch (err) {
      if (mounted.current) setError(messageFromError(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const next = () => {
    if (busy) return;
    if (state.step < 0 && !state.idea.trim()) return;
    if (last) {
      void draft();
      return;
    }
    hapticSelection();
    patch({ step: state.step + 1 });
  };

  const back = () => {
    if (busy) return;
    if (state.step < 0) onBack();
    else patch({ step: state.step - 1 });
  };

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={t("New assistant")}
        onBack={back}
        backLabel={state.step < 0 ? t("Assistants") : t("Back")}
      />
      <div className="mobile-scroll mobile-assistant-flow-body">
        {question ? (
          <div
            className="mobile-assistant-flow-progress"
            role="progressbar"
            aria-label={t("Question {current} of {total}", {
              current: state.step + 1,
              total: questions.length,
            })}
            aria-valuemin={1}
            aria-valuemax={questions.length}
            aria-valuenow={state.step + 1}
          >
            {questions.map((entry, index) => (
              <span key={entry.id} data-done={index <= state.step ? "true" : undefined} />
            ))}
          </div>
        ) : null}

        {!question ? (
          <>
            <h2 className="mobile-assistant-flow-title">{t("What would you like to create?")}</h2>
            <p className="mobile-assistant-flow-lead">
              {t("Describe the help you want. A few answers will shape your assistant.")}
            </p>
            {restored ? (
              <p className="mobile-assistant-flow-note">
                {t("Your draft was restored.")}{" "}
                <button
                  type="button"
                  className="mobile-assistant-flow-link"
                  onClick={() => {
                    clearCreatorDraft();
                    setState(START);
                    setRestored(false);
                    fieldRef.current?.focus();
                  }}
                >
                  {t("Start over")}
                </button>
              </p>
            ) : null}
            <textarea
              ref={fieldRef}
              className="mobile-assistant-flow-field"
              rows={5}
              value={state.idea}
              aria-label={t("Your idea")}
              placeholder={t("An assistant that helps me…")}
              onChange={(event) => patch({ idea: event.target.value })}
            />
            <button type="button" className="mobile-assistant-flow-link" onClick={onWriteMyself}>
              {t("Write instructions myself")}
            </button>
          </>
        ) : (
          <fieldset className="mobile-assistant-flow-question" disabled={busy}>
            <legend className="mobile-assistant-flow-title">{question.label}</legend>
            {question.options.length > 0 ? (
              <div className="mobile-assistant-flow-chips">
                {question.options.map((option) => {
                  const chosen = (state.answers[question.id] ?? []).includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      className="mobile-assistant-flow-chip"
                      aria-pressed={chosen}
                      onClick={() => toggle(option)}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <textarea
              className="mobile-assistant-flow-field"
              rows={question.type === "text" ? 5 : 3}
              aria-label={question.type === "text" ? t("Your answer") : t("Add your own answer")}
              placeholder={question.type === "text" ? t("Your answer") : t("Add your own answer")}
              value={state.freeAnswers[question.id] ?? ""}
              onChange={(event) =>
                patch({
                  freeAnswers: { ...state.freeAnswers, [question.id]: event.target.value },
                })
              }
            />
          </fieldset>
        )}
        {error ? (
          <p className="mobile-dictation-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div
        className="mobile-assistant-flow-footer"
        style={keyboardInset ? { paddingBottom: keyboardInset } : undefined}
      >
        <button
          type="button"
          className="mobile-studio-generate mobile-assistant-flow-next"
          disabled={busy || (state.step < 0 && !state.idea.trim())}
          onClick={next}
        >
          {busy ? <Spinner aria-hidden /> : null}
          {busy
            ? t("Preparing your draft…")
            : last
              ? t("Prepare my draft")
              : state.step < 0
                ? t("Continue")
                : t("Next")}
        </button>
      </div>
    </div>
  );
}
