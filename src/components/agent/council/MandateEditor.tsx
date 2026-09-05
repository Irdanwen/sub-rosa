import { t } from "../../../lib/i18n";
import { IconCirclePlus } from "central-icons/IconCirclePlus";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import type { AcceptanceCriterion, Mandate } from "../../../lib/council";

/**
 * The mandate, as fields the user can change before it is issued.
 *
 * Lists are edited one line per entry rather than as free text, because the
 * caps are per entry and a textarea would let someone write five deliverables
 * on one line and wonder why four of them vanished. Acceptance criteria are
 * two inputs on purpose: a criterion with no way of being checked is refused,
 * and the surface should make that visible while it is being typed rather than
 * on submit.
 *
 * Nothing here composes a prompt. The edited fields go back to Rust and
 * `mandate::render` makes the string again, so "the app owns the prompt" holds
 * even when the user is the author of the fields (ADR-0034).
 */
export function MandateEditor({
  mandate,
  onChange,
  disabled,
}: {
  mandate: Mandate;
  onChange: (next: Mandate) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<Mandate>) => onChange({ ...mandate, ...patch });

  return (
    <div className="council-mandate">
      <label className="council-field">
        <span className="council-field-label">{t("Objective")}</span>
        <textarea
          className="council-input"
          rows={2}
          value={mandate.objective}
          disabled={disabled}
          onChange={(event) => set({ objective: event.target.value })}
          placeholder={t("What changes in the world, in one sentence.")}
        />
      </label>

      <ListField
        label={t("Deliverable")}
        hint={t("What must exist when this is done.")}
        values={mandate.deliverable}
        disabled={disabled}
        onChange={(deliverable) => set({ deliverable })}
      />

      <ListField
        label={t("Constraints")}
        hint={t("What must not change.")}
        values={mandate.constraints}
        disabled={disabled}
        onChange={(constraints) => set({ constraints })}
      />

      <fieldset className="council-field council-criteria">
        <legend className="council-field-label">{t("Acceptance criteria")}</legend>
        <p className="council-field-hint">
          {t(
            "Each one says how it is checked. This is what the verdict reads, so a criterion with no means of verification is refused.",
          )}
        </p>
        {mandate.acceptance.map((criterion, index) => (
          <CriterionRow
            // Index is the identity here: criteria have no id, and reordering
            // is not offered, so a row's position is stable for its lifetime.
            // biome-ignore lint/suspicious/noArrayIndexKey: no stable id exists on a criterion
            key={index}
            criterion={criterion}
            disabled={disabled}
            onChange={(next) =>
              set({
                acceptance: mandate.acceptance.map((entry, position) =>
                  position === index ? next : entry,
                ),
              })
            }
            onRemove={() =>
              set({ acceptance: mandate.acceptance.filter((_, position) => position !== index) })
            }
          />
        ))}
        <button
          type="button"
          className="council-add"
          disabled={disabled}
          onClick={() =>
            set({ acceptance: [...mandate.acceptance, { statement: "", verifiedBy: "" }] })
          }
        >
          <IconCirclePlus size={14} aria-hidden />
          {t("Add a criterion")}
        </button>
      </fieldset>

      <ListField
        label={t("Out of scope")}
        hint={t("Deliberately excluded, so nobody does it as a favour.")}
        values={mandate.outOfScope}
        disabled={disabled}
        onChange={(outOfScope) => set({ outOfScope })}
      />

      <label className="council-field">
        <span className="council-field-label">{t("First step")}</span>
        <input
          className="council-input"
          value={mandate.firstStep}
          disabled={disabled}
          onChange={(event) => set({ firstStep: event.target.value })}
          placeholder={t("Where the work starts.")}
        />
      </label>
    </div>
  );
}

function CriterionRow({
  criterion,
  onChange,
  onRemove,
  disabled,
}: {
  criterion: AcceptanceCriterion;
  onChange: (next: AcceptanceCriterion) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const unverifiable = criterion.statement.trim() !== "" && criterion.verifiedBy.trim() === "";
  return (
    <div className="council-criterion" data-unverifiable={unverifiable || undefined}>
      <input
        className="council-input"
        value={criterion.statement}
        disabled={disabled}
        onChange={(event) => onChange({ ...criterion, statement: event.target.value })}
        placeholder={t("A checkable statement about the finished work")}
        aria-label={t("Criterion")}
      />
      <input
        className="council-input council-input-verify"
        value={criterion.verifiedBy}
        disabled={disabled}
        onChange={(event) => onChange({ ...criterion, verifiedBy: event.target.value })}
        placeholder={t("Verified by: a command, a file, a page")}
        aria-label={t("How this criterion is verified")}
      />
      <button
        type="button"
        className="icon-button"
        disabled={disabled}
        onClick={onRemove}
        aria-label={t("Remove this criterion")}
      >
        <IconCrossSmall size={14} aria-hidden />
      </button>
    </div>
  );
}

function ListField({
  label,
  hint,
  values,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  values: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="council-field">
      <legend className="council-field-label">{label}</legend>
      <p className="council-field-hint">{hint}</p>
      {values.map((value, index) => (
        // A line has no identity beyond its position, and reordering is not
        // offered, so the position is stable for the row's lifetime.
        // biome-ignore lint/suspicious/noArrayIndexKey: a line has no stable id
        <div className="council-line" key={`${label}-${index}`}>
          <input
            className="council-input"
            value={value}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                values.map((entry, position) => (position === index ? event.target.value : entry)),
              )
            }
            aria-label={label}
          />
          <button
            type="button"
            className="icon-button"
            disabled={disabled}
            onClick={() => onChange(values.filter((_, position) => position !== index))}
            aria-label={t("Remove this {value} entry", { value: label.toLowerCase() })}
          >
            <IconCrossSmall size={14} aria-hidden />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="council-add"
        disabled={disabled}
        onClick={() => onChange([...values, ""])}
      >
        <IconCirclePlus size={14} aria-hidden />
        {t("Add a line")}
      </button>
    </fieldset>
  );
}
