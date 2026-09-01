import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { type ReactNode, useState } from "react";
import { hapticSelection } from "../../../../lib/haptics";
import { isMobilePlatform } from "../../../../lib/mobile";
import { setPlaybackAudioSession } from "../../../../lib/tauri";
import { Switch } from "../../../ui/Switch";

/**
 * The parts every Studio panel is built from.
 *
 * They were defined between the panels that use them, which is how a file
 * reaches three thousand lines: nothing is wrong with any one of them, and
 * there is no line at which the next helper obviously belongs somewhere else.
 * Gathering them here is what makes one file per tab possible -- each panel now
 * imports its furniture instead of sitting next to it.
 *
 * Nothing here changed on the way over. `mobile-studio-smoke.test.tsx` mounts
 * every tab, which is what makes that claim checkable rather than promised.
 */

/** Best-effort iOS audio-session flip around media playback: `.playback`
 * keeps generated music/video audible past the lock screen and the silent
 * switch. No-op off iOS (the command only exists there). */
export function markMediaPlayback(active: boolean) {
  if (!isMobilePlatform()) return;
  void setPlaybackAudioSession(active).catch(() => undefined);
}

// --- Model picker button --------------------------------------------------------

export function ModelPickerButton({
  label,
  value,
  hint,
  onOpen,
}: {
  label: string;
  value: string;
  /** What the choice resolved to, when the row's value does not say it all
   * (a video family is one row for up to four backend models). */
  hint?: string;
  onOpen: () => void;
}) {
  const chosen = value || "Choose";
  return (
    <button
      type="button"
      className="mobile-model-select"
      onClick={onOpen}
      // The hint is the part that changes under the user without a tap, so it
      // has to reach a screen reader too.
      aria-label={hint ? `${label}, ${chosen}, ${hint}` : label}
    >
      <span className="mobile-model-select-label">{label}</span>
      <span className="mobile-model-select-choice">
        <span className="mobile-model-select-value">{chosen}</span>
        {hint ? <span className="mobile-model-select-hint">{hint}</span> : null}
      </span>
    </button>
  );
}

/** Strip a `data:...;base64,` prefix so the raw bytes can go to /image/upscale,
 * which (unlike /image/edit) rejects a data URI. */
export function rawBase64(dataUri: string): string {
  return dataUri.replace(/^data:[^,]+,/, "");
}

/** The current value when the model still offers it, else its first option. A
 * stored choice can go stale when the model changes and drops that option. */
export function pickEffective(options: string[], value: string): string {
  return value && options.includes(value) ? value : (options[0] ?? "");
}

/** A labelled settings row: a caption above its control (pills, an input...). */
export function StudioSetting({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="mobile-studio-field">
      <div className="mobile-studio-field-head">
        <span className="mobile-studio-field-label">{label}</span>
        {hint ? <span className="mobile-studio-field-value">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A labelled integer slider with a live value readout (Steps, Variants). */
export function SliderSetting({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mobile-studio-field">
      <div className="mobile-studio-field-head">
        <span className="mobile-studio-field-label">{label}</span>
        <span className="mobile-studio-field-value">{value}</span>
      </div>
      <input
        type="range"
        className="mobile-studio-slider"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

/** A labelled switch row. Studio used raw `<input type="checkbox">`, which
 * renders as the iOS system checkbox: a blue tick that belongs to no other
 * surface in the app now that Settings uses `Switch`. */
export function StudioToggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  hint?: ReactNode;
}) {
  return (
    <div className="mobile-toggle-row">
      <span className="mobile-toggle-label">
        {label}
        {hint ? <span className="mobile-toggle-hint">{hint}</span> : null}
      </span>
      <Switch
        checked={checked}
        onCheckedChange={(next) => {
          hapticSelection();
          onChange(next);
        }}
        aria-label={typeof label === "string" ? label : undefined}
      />
    </div>
  );
}

/** Everything past "describe it and go", folded away by default.
 *
 * The generate form exposed nine controls at once, which pushed the Generate
 * button itself below the fold: the primary action was the one thing you
 * could not see. */
export function MoreOptions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mobile-studio-more" data-open={open ? "true" : undefined}>
      <button
        type="button"
        className="mobile-studio-more-trigger"
        aria-expanded={open}
        onClick={() => {
          hapticSelection();
          setOpen((current) => !current);
        }}
      >
        <span>{open ? "Fewer options" : "More options"}</span>
        <IconChevronDownSmall size={14} aria-hidden />
      </button>
      {open ? <div className="mobile-studio-more-body">{children}</div> : null}
    </div>
  );
}
