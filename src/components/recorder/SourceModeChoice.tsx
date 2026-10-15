import { IconCall } from "central-icons/IconCall";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconVolumeFull } from "central-icons/IconVolumeFull";
import type { ReactNode } from "react";
import { t } from "../../lib/i18n";
import { RECORDING_SOURCE_MODES, sourceModeIncludesSystem } from "../../lib/recording-source-mode";
import type { SystemAudioAvailability } from "../../lib/source-readiness";
import type { RecordingSourceMode, SourceReadinessDto } from "../../lib/tauri";

const OPTIONS: Record<
  RecordingSourceMode,
  { icon: ReactNode; label: () => string; hint: () => string }
> = {
  microphonePlusSystem: {
    icon: <IconCall size={16} aria-hidden />,
    label: () => t("Microphone and computer"),
    hint: () => t("For a call"),
  },
  microphoneOnly: {
    icon: <IconMicrophone size={16} aria-hidden />,
    label: () => t("Microphone only"),
    hint: () => t("For a meeting in the room"),
  },
  systemOnly: {
    icon: <IconVolumeFull size={16} aria-hidden />,
    label: () => t("Computer only"),
    hint: () => t("For a webinar or a video, without your voice"),
  },
};

type SourceModeChoiceProps = {
  /** Distinguishes the radio group when two choices are on screen. */
  name: string;
  value: RecordingSourceMode;
  onChange: (mode: RecordingSourceMode) => void;
  availability: SystemAudioAvailability;
  recoveryAction?: SourceReadinessDto["recoveryAction"];
  onEnableSystemAudio: () => void;
  disabled?: boolean;
  className?: string;
};

/**
 * What a note records, named by the situation rather than by the plumbing.
 * The choice stays selectable when the computer cannot be heard today: what
 * changes is the sentence under it, which says what will happen instead and
 * how to fix it, so nothing is decided behind the person's back.
 */
export function SourceModeChoice({
  name,
  value,
  onChange,
  availability,
  recoveryAction,
  onEnableSystemAudio,
  disabled = false,
  className,
}: SourceModeChoiceProps) {
  const note = sourceModeIncludesSystem(value)
    ? computerNote(value, availability, recoveryAction)
    : null;
  return (
    <div className={["source-mode-choice", className].filter(Boolean).join(" ")}>
      <div className="source-mode-options" role="radiogroup" aria-label={t("What to record")}>
        {RECORDING_SOURCE_MODES.map((mode) => {
          const option = OPTIONS[mode];
          return (
            <label key={mode} className="source-mode-option" data-selected={mode === value}>
              <input
                type="radio"
                className="source-mode-radio"
                name={name}
                value={mode}
                checked={mode === value}
                disabled={disabled}
                onChange={() => onChange(mode)}
              />
              <span className="source-mode-icon">{option.icon}</span>
              <span className="source-mode-text">
                <span className="source-mode-label">{option.label()}</span>
                <span className="source-mode-hint">{option.hint()}</span>
              </span>
            </label>
          );
        })}
      </div>
      {note ? (
        <p className="source-mode-note" role="status">
          <span>{note}</span>
          {availability === "denied" ? (
            <button
              type="button"
              className="btn btn-ghost source-mode-enable"
              onClick={onEnableSystemAudio}
            >
              {t("Enable")}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function computerNote(
  mode: RecordingSourceMode,
  availability: SystemAudioAvailability,
  recoveryAction: SourceReadinessDto["recoveryAction"],
): string | null {
  const microphoneStillRecords = mode === "microphonePlusSystem";
  if (availability === "denied") {
    return microphoneStillRecords
      ? t("The computer's sound is not allowed yet, so only the microphone will record.")
      : t("The computer's sound is not allowed yet.");
  }
  if (availability !== "unavailable") return null;
  if (recoveryAction === "checkSoundOutput") {
    return t("No sound output is connected. Connect speakers or headphones, then try again.");
  }
  return microphoneStillRecords
    ? t("The computer's sound is not available right now, so only the microphone will record.")
    : t("The computer's sound is not available right now. Restart Sub Rosa, then try again.");
}
