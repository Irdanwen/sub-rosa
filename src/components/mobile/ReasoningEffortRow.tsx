// The reasoning effort choice, shown in the chat's model sheet for a model
// that honours one. "Default" sends nothing and leaves it to the provider.

import { hapticSelection } from "../../lib/haptics";
import { t } from "../../lib/i18n";
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
  reasoningEffortLabel,
} from "../../lib/reasoning-effort";

export function ReasoningEffortRow({
  value,
  onChange,
}: {
  value: ReasoningEffort | undefined;
  onChange: (effort: ReasoningEffort | undefined) => void;
}) {
  return (
    <div className="mobile-effort">
      <span className="mobile-effort-label">{t("Reasoning effort")}</span>
      <fieldset className="mobile-effort-pills" aria-label={t("Reasoning effort")}>
        {[undefined, ...REASONING_EFFORTS].map((effort) => (
          <button
            key={effort ?? "default"}
            type="button"
            aria-pressed={value === effort}
            className="mobile-pill"
            data-active={value === effort ? "true" : undefined}
            onClick={() => {
              hapticSelection();
              onChange(effort);
            }}
          >
            {reasoningEffortLabel(effort)}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
