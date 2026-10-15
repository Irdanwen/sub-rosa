import { t } from "../../lib/i18n";
import { useRef } from "react";
import type { RecordingStatusDto } from "../../lib/tauri";
import { combineSourceAudioLevels, Waveform } from "./Waveform";
import { useRecordingPresenceBounds } from "../../lib/recording-presence-bounds";

type GlobalRecorderPillProps = {
  status: RecordingStatusDto;
  // Title of the note the recording belongs to. Not shown, but it names the
  // click target for assistive tech.
  title: string;
  // Jump back to the recording's note.
  onOpen: () => void;
};

// A floating "still recording" presence that rides over the content card while
// a recording is live but you've navigated off its note. It keeps the in-app
// version quieter than the native HUD: a contained waveform. Click to return
// to the note for controls.
export function GlobalRecorderPill({ status, title, onOpen }: GlobalRecorderPillProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const recording = status.state === "recording";
  useRecordingPresenceBounds(buttonRef);
  // status.level is mic-only; status.sources carries mic+system when available.
  const meterLevel =
    status.sources && status.sources.length > 0
      ? combineSourceAudioLevels(status.sources)
      : status.level;

  return (
    <button
      ref={buttonRef}
      type="button"
      className="global-recorder-pill"
      data-state={status.state}
      // A take with a warning (a stalled microphone, a computer never heard)
      // marks the pill, so the note is worth a look from wherever you are.
      data-warning={status.warnings?.length ? true : undefined}
      onClick={onOpen}
      aria-label={t("Open recording: {name}", { name: title })}
      title={t("Open recording")}
    >
      <Waveform level={meterLevel} active={recording} />
    </button>
  );
}
