import { sourceModeIncludesMicrophone, sourceModeIncludesSystem } from "./recording-source-mode";
import type { RecordingSource, RecordingSourceMode, RecordingStatusDto } from "./tauri";

/** Adapt a just-started `RecordingSessionDto` into the `RecordingStatusDto`
 * shape the recorder UI polls for, so the bar renders immediately instead of
 * waiting for the first status poll. Shared by the desktop and mobile shells. */
export function recordingToStatus(recording: {
  id: string;
  noteId?: string;
  sourceMode?: RecordingStatusDto["sourceMode"];
  state: RecordingStatusDto["state"];
  elapsedMs: number;
  level: RecordingStatusDto["level"];
  livePreviewEnabled?: RecordingStatusDto["livePreviewEnabled"];
  sources?: RecordingStatusDto["sources"];
  warnings?: RecordingStatusDto["warnings"];
}): RecordingStatusDto {
  return {
    sessionId: recording.id,
    noteId: recording.noteId,
    sourceMode: recording.sourceMode,
    state: recording.state,
    elapsedMs: recording.elapsedMs,
    level: recording.level,
    silenceWarning: false,
    bytesWritten: 0,
    livePreviewEnabled: recording.livePreviewEnabled ?? false,
    sources: recording.sources,
    warnings: recording.warnings,
  };
}

/** The placeholder status shown between pressing record and the capture
 * answering: one starting lane per source the mode records. */
export function startingRecordingStatus(
  noteId: string,
  sourceMode: RecordingSourceMode,
): RecordingStatusDto {
  const lanes: RecordingSource[] = [];
  if (sourceModeIncludesMicrophone(sourceMode)) lanes.push("microphone");
  if (sourceModeIncludesSystem(sourceMode)) lanes.push("system");
  return {
    sessionId: "",
    noteId,
    sourceMode,
    state: "starting",
    elapsedMs: 0,
    level: { peak: 0, rms: 0, recentPeaks: [] },
    silenceWarning: false,
    bytesWritten: 0,
    livePreviewEnabled: false,
    sources: lanes.map((source) => ({
      source,
      state: "starting",
      elapsedMs: 0,
      bytesWritten: 0,
      level: { peak: 0, rms: 0, recentPeaks: [] },
      silenceWarning: false,
      pathFinalized: false,
    })),
    warnings: [],
  };
}
