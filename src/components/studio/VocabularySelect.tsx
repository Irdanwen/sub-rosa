import { t } from "../../lib/i18n";
import { VOCABULARY_EFFECTS, VOCABULARY_LABELS } from "../../lib/studio/direction/labels";
import { entries, type VocabularyCategory } from "../../lib/studio/direction/vocabulary";

/**
 * A choice from the prompt bible's vocabulary: the label a person reads, the
 * effect it has on screen as a hint, and the English the model reads kept
 * out of sight.
 */
export function VocabularySelect({
  label,
  category,
  value,
  onChange,
  emptyLabel,
  disabled,
  hint = true,
  required = false,
}: {
  label: string;
  category: VocabularyCategory;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** What nothing chosen means here. */
  emptyLabel?: string;
  disabled?: boolean;
  hint?: boolean;
  /** Always one of the values: no empty choice. */
  required?: boolean;
}) {
  const labels = VOCABULARY_LABELS[category];
  const effect = value ? VOCABULARY_EFFECTS[category]?.[value] : undefined;
  return (
    <label className="project-field">
      {label}
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        {required ? null : <option value="">{emptyLabel ?? t("Not set")}</option>}
        {entries(category).map((item) => (
          <option key={item.id} value={item.id}>
            {labels[item.id] ?? item.id}
          </option>
        ))}
      </select>
      {hint && effect ? <span className="project-field-hint">{effect}</span> : null}
    </label>
  );
}
