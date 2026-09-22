import { t } from "../../../../lib/i18n";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { type ReactNode, useState } from "react";
import { hapticSelection } from "../../../../lib/haptics";
import { isIosPlatform } from "../../../../lib/mobile";
import { modelPrivacyBadge } from "../../../../lib/model-privacy";
import { setPlaybackAudioSession } from "../../../../lib/tauri";
import { Switch } from "../../../ui/Switch";
import { OptionSheet } from "../../OptionSheet";

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
  if (!isIosPlatform()) return;
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
  const chosen = value || t("Choose");
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

/** The line under a model's name in a picker: its tier and what happens to
 * the prompt, in words. The catalog's own values ("standard · anonymized")
 * were shown as they came, in English. */
export function modelSubtitle(model: { tier?: string; privacy?: string }): string {
  const parts: string[] = [];
  const tier = model.tier?.trim().toLowerCase();
  if (tier === "standard") parts.push(t("Standard"));
  else if (tier === "premium") parts.push(t("Premium"));
  else if (tier) parts.push(tier[0].toUpperCase() + tier.slice(1));
  const privacy = modelPrivacyBadge({ privacy: model.privacy, traits: [] });
  if (privacy?.mode === "private") parts.push(t("Zero data retention"));
  else if (privacy?.mode === "anonymous") parts.push(t("Anonymous mode"));
  else if (privacy) parts.push(privacy.label);
  return parts.join(" · ");
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

/** A group of settings read as one card of rows, the way iOS Settings reads. */
export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="mobile-select-card">{children}</div>;
}

/**
 * One setting with a short list of values: its name, what is chosen, a
 * chevron. A tap brings the list up as a sheet. See `OptionSheet` for why
 * this replaced the rows of pills.
 */
export function SelectRow({
  label,
  value,
  options,
  onChange,
  format = (option) => option,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  /** How a raw option reads ("5s" as "5 s", "auto" as "Auto"). */
  format?: (option: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const shown = format(value);
  return (
    <>
      <button
        type="button"
        className="mobile-select-row"
        aria-haspopup="dialog"
        aria-label={`${label}, ${shown}`}
        onClick={() => {
          hapticSelection();
          setOpen(true);
        }}
      >
        <span className="mobile-select-row-label">{label}</span>
        <span className="mobile-select-row-value">
          {shown}
          <IconChevronRightSmall size={16} aria-hidden />
        </span>
      </button>
      {open ? (
        <OptionSheet
          title={label}
          options={options.map((option) => ({ value: option, label: format(option) }))}
          selected={value}
          onSelect={(next) => {
            onChange(next);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** How a render setting reads: "5s" as "5 s", "auto" as "Auto". The wire
 * values stay as they are; only the words change. */
export function formatRenderOption(option: string): string {
  if (option === "auto") return t("Auto");
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(option);
  if (seconds) return t("{count} s", { count: seconds[1] });
  return option;
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
export function MoreOptions({
  children,
  defaultOpen = false,
}: {
  children: ReactNode;
  /** Start unfolded, when something inside is already filled in: a choice
   * hidden behind a closed disclosure is a choice the person forgets. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
        <span>{open ? t("Fewer options") : t("More options")}</span>
        <IconChevronDownSmall size={14} aria-hidden />
      </button>
      {open ? <div className="mobile-studio-more-body">{children}</div> : null}
    </div>
  );
}
