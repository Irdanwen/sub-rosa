import type { RecordingStatusDto } from "./tauri";

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
