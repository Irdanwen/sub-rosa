import { t } from "../../lib/i18n";
import { IconPause } from "central-icons-filled/IconPause";
import { IconPlay } from "central-icons-filled/IconPlay";
import { IconStop } from "central-icons-filled/IconStop";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconVolumeFull } from "central-icons/IconVolumeFull";
import { scaleLiveInputPeak } from "../../lib/audio-meter";
import type { RecordingStatusDto, SourceStatusDto } from "../../lib/tauri";
import {
  combineSourceAudioLevels,
  scaleAudioLevel,
  SOURCE_VISUAL_GAIN,
  Waveform,
} from "./Waveform";

type RecorderBarProps = {
  status: RecordingStatusDto;
  onPause: (sessionId: string) => void;
  onResume: (sessionId: string) => void;
  onDone: (sessionId: string) => void;
};

export function RecorderBar({ status, onPause, onResume, onDone }: RecorderBarProps) {
  const paused = status.state === "paused";
  const controlsEnabled = status.state === "recording" || status.state === "paused";
  // status.level is mic-only; status.sources carries mic+system when available.
  const meterLevel =
    status.sources && status.sources.length > 0
      ? combineSourceAudioLevels(status.sources)
      : status.level;
  const pauseLabel = paused
    ? t("Resume")
    : status.state === "recording"
      ? t("Pause")
      : status.state === "starting"
        ? t("Starting")
        : t("Finalizing");
  // With two lanes, each says on its own that it is being heard: the mixed
  // waveform cannot show that the call is missing while the person talks.
  const lanes = status.sources && status.sources.length > 1 ? status.sources : [];

  return (
    <div className="recorder-bar" data-state={status.state} data-lanes={lanes.length || undefined}>
      <button
        type="button"
        className="recorder-icon-button"
        disabled={!controlsEnabled}
        onClick={() => (paused ? onResume(status.sessionId) : onPause(status.sessionId))}
        aria-label={pauseLabel}
        title={pauseLabel}
      >
        {paused ? <IconPlay size={14} /> : <IconPause size={14} />}
      </button>
      <div className="recorder-meter">
        <span className="elapsed">{formatElapsed(status.elapsedMs)}</span>
        <Waveform level={meterLevel} active={status.state === "recording"} />
        {lanes.length > 0 ? (
          <span className="recorder-lanes">
            {lanes.map((lane) => (
              <RecorderLane key={lane.source} lane={lane} />
            ))}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="recorder-stop"
        disabled={!controlsEnabled}
        onClick={() => onDone(status.sessionId)}
        aria-label={controlsEnabled ? t("Done") : t("Working")}
        title={controlsEnabled ? t("Done") : t("Working")}
      >
        <IconStop size={14} />
      </button>
    </div>
  );
}

function RecorderLane({ lane }: { lane: SourceStatusDto }) {
  const level = scaleAudioLevel(lane.level, SOURCE_VISUAL_GAIN[lane.source]);
  const recent = level.recentPeaks.length > 0 ? Math.max(...level.recentPeaks) : level.peak;
  const heard = scaleLiveInputPeak(recent) > 0.05;
  const name = lane.source === "system" ? t("Computer") : t("Microphone");
  const label = lane.silenceWarning
    ? t("{source}: no sound yet", { source: name })
    : heard
      ? t("{source}: sound detected", { source: name })
      : name;
  return (
    <span
      className="recorder-lane"
      data-source={lane.source}
      data-heard={heard || undefined}
      data-silent={lane.silenceWarning || undefined}
      role="img"
      aria-label={label}
      title={label}
    >
      {lane.source === "system" ? <IconVolumeFull size={12} /> : <IconMicrophone size={12} />}
    </span>
  );
}

export function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
