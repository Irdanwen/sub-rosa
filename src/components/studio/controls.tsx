// Small shared form controls for the Studio views. All of them lean on the
// studio.css classes and the app's design tokens; none carry local styling.

import { t } from "../../lib/i18n";
import type { ReactNode } from "react";
import { formatCredits } from "../../lib/studio/catalog";
import type { MediaModel } from "../../lib/studio/types";
import { MediaModelPicker, mediaModelOption } from "./MediaModelPicker";

/** A labeled form row in the controls column. */
export function StudioField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="studio-field">
      <div className="studio-field-head">
        <span className="studio-field-label">{label}</span>
        {hint ? <span className="studio-field-hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** Exclusive pill choices (aspect ratios, resolutions, durations...). */
export function PillGroup<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label?: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="studio-pills" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          data-active={option.value === value}
          className="studio-pill"
          onClick={() => onChange(option.value)}
        >
          {option.label ?? option.value}
        </button>
      ))}
    </div>
  );
}

/** Searchable model picker fed by the merged catalog's published metadata. */
export function ModelSelect({
  models,
  value,
  onChange,
  ariaLabel,
}: {
  models: MediaModel[];
  value: string | null;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <MediaModelPicker
      value={value}
      placeholder={t("Choose a model")}
      ariaLabel={ariaLabel}
      onChange={onChange}
      options={models.filter((model) => !model.offline).map(mediaModelOption)}
    />
  );
}

/** Estimated price of the next generation, when the catalog knows it. */
export function CostHint({ credits }: { credits?: number }) {
  if (credits === undefined) return null;
  return <span className="studio-cost">~{formatCredits(credits)}</span>;
}

/** Range slider with the current value spelled out next to the label. */
export function SliderField({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <StudioField label={label} hint={format ? format(value) : String(value)}>
      <input
        type="range"
        className="studio-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </StudioField>
  );
}

/** A clip position or length, to a tenth of a second. */
export function formatSeconds(value: number): string {
  return `${Math.round(value * 10) / 10}s`;
}

/** Keeps a selection valid when the option list changes with the model. */
export function effectiveOption<T extends string>(options: readonly T[], selected: T | ""): T | "" {
  if (options.length === 0) return "";
  return options.includes(selected as T) ? selected : options[0];
}
