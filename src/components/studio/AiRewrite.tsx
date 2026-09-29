import { IconArrowsRepeat } from "central-icons/IconArrowsRepeat";
import { IconSparkle } from "central-icons/IconSparkle";
import { IconCheckmark1 } from "central-icons-filled/IconCheckmark1";
import { useState } from "react";
import { t } from "../../lib/i18n";
import {
  type ScenarioIntent,
  type StudioRewriteInput,
  useStudioRewrite,
} from "../../lib/studio/studio-rewrite";
import { DotSpinner } from "../DotSpinner";
import { InlineNotice } from "../ui/InlineNotice";

/**
 * "Improve with AI" under a Studio text field.
 *
 * The proposal is shown and never applied (ADR-0038): it replaces text the
 * person wrote, so it waits for Accept. Accepting keeps what it replaced until
 * the field changes again, so one tap brings it back.
 */
export function AiRewrite({
  value,
  onAccept,
  request,
  intents,
  hint,
  disabled,
  label,
}: {
  value: string;
  onAccept: (text: string) => void;
  /** Builds the request from the chosen intent and instruction. `undefined`
   * when there is nothing to work from yet. */
  request: (intent?: ScenarioIntent, instruction?: string) => StudioRewriteInput | undefined;
  /** Offered as a choice before the button. Scenario only. */
  intents?: { value: ScenarioIntent; label: string }[];
  /** A sentence under the proposal, about what the proposal is. */
  hint?: string;
  disabled?: boolean;
  /** What the field is, for the proposal's accessible name. */
  label: string;
}) {
  const { run, start, stop, dismiss } = useStudioRewrite();
  const [intent, setIntent] = useState<ScenarioIntent | undefined>(intents?.[0]?.value);
  const [instruction, setInstruction] = useState("");
  const [previous, setPrevious] = useState<{ before: string; after: string }>();
  const input = request(intent, intent === "custom" ? instruction : undefined);
  const needsInstruction = intent === "custom" && !instruction.trim();
  const running = run?.status === "running";
  const ready = run?.status === "ready" && run.text.trim().length > 0;
  const canUndo = previous !== undefined && previous.after === value;

  const begin = () => {
    if (input) start(input);
  };

  return (
    <div className="ai-rewrite">
      <div className="ai-rewrite-controls">
        {intents ? (
          <select
            aria-label={t("What to do")}
            value={intent}
            disabled={disabled || running}
            onChange={(event) => setIntent(event.target.value as ScenarioIntent)}
          >
            {intents.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        {intent === "custom" ? (
          <input
            aria-label={t("Your instruction")}
            placeholder={t("For example: make it darker, set it in winter")}
            value={instruction}
            disabled={disabled || running}
            onChange={(event) => setInstruction(event.target.value)}
          />
        ) : null}
        <button
          type="button"
          className="btn btn-secondary ai-rewrite-start"
          disabled={disabled || running || !input || needsInstruction}
          onClick={begin}
        >
          <IconSparkle size={14} aria-hidden />
          {value.trim() ? t("Improve with AI") : t("Write with AI")}
        </button>
        {canUndo ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onAccept(previous.before);
              setPrevious(undefined);
            }}
          >
            {t("Undo")}
          </button>
        ) : null}
      </div>
      {run ? (
        <section
          className="ai-rewrite-proposal"
          aria-label={t("Proposal for {field}", { field: label })}
        >
          <header>
            <span>{t("Proposal")}</span>
            {running ? <DotSpinner /> : null}
          </header>
          {run.status === "failed" || run.status === "cancelled" ? (
            <InlineNotice
              tone="warning"
              body={run.error ?? t("That rewrite did not go through.")}
            />
          ) : (
            <div className="ai-rewrite-body" aria-live="polite" aria-busy={running}>
              {run.text || <span className="project-muted">{t("Writing")}</span>}
            </div>
          )}
          {hint && ready ? <p className="project-muted">{hint}</p> : null}
          <footer>
            {running ? (
              <button type="button" className="btn btn-ghost" onClick={stop}>
                {t("Stop")}
              </button>
            ) : (
              <>
                {ready ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setPrevious({ before: value, after: run.text });
                      onAccept(run.text);
                      dismiss();
                    }}
                  >
                    <IconCheckmark1 size={14} aria-hidden />
                    {t("Accept")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!input || needsInstruction}
                  onClick={begin}
                >
                  <IconArrowsRepeat size={14} aria-hidden />
                  {t("Try again")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={dismiss}>
                  {t("Discard")}
                </button>
              </>
            )}
          </footer>
        </section>
      ) : null}
    </div>
  );
}
