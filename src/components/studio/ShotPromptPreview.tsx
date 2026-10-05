import { t } from "../../lib/i18n";
import type { ComposedPrompt } from "../../lib/studio/prompt/compose";
import type { Lint } from "../../lib/studio/prompt/lint";

/**
 * The prompt the take will be rendered from, block by block, before anything
 * is spent: what the budget left out, how the line will be heard, and what
 * the prompt bible would warn about.
 */
export function ShotPromptPreview({
  composed,
  lints,
  overridden,
  modelName,
}: {
  composed: ComposedPrompt;
  lints: readonly Lint[];
  /** A prompt written by hand or by AI replaces this one. */
  overridden: boolean;
  modelName?: string;
}) {
  return (
    <details className="project-prompt-preview" open={!overridden && lints.length > 0}>
      <summary>
        {overridden ? t("Composed prompt, replaced by yours") : t("Composed prompt")}
        <span
          className={composed.overBy > 0 ? "project-badge project-badge-warning" : "project-badge"}
        >
          {t("{words} of {budget} words", { words: composed.words, budget: composed.budget })}
        </span>
      </summary>
      <pre className="project-prompt-text">{composed.text}</pre>
      {composed.overBy > 0 ? (
        <p className="project-warning">
          {t(
            "{count} words over this model's budget, with only what never goes left. Shorten the action or a descriptor.",
            { count: composed.overBy },
          )}
        </p>
      ) : null}
      {composed.dropped.length > 0 ? (
        <p className="project-field-hint">
          {t("Left out to fit: {parts}", { parts: composed.dropped.join(" · ") })}
        </p>
      ) : null}
      {composed.dialogue.mode === "native" ? (
        <p className="project-field-hint">
          {t("{model} speaks the line itself, with lip sync.", {
            model: modelName ?? t("The video model"),
          })}
        </p>
      ) : composed.dialogue.mode === "dubbed" ? (
        <p className="project-field-hint">
          {composed.silenceAudio
            ? t("The line is dubbed: the take renders without sound.")
            : composed.muteInMontage
              ? t("The line is dubbed: the take's own sound is muted in the montage.")
              : t("The line is dubbed afterwards.")}
        </p>
      ) : null}
      {lints.length > 0 ? (
        <ul className="project-prompt-lints">
          {lints.map((lint) => (
            <li key={lint.id}>{lint.message}</li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
