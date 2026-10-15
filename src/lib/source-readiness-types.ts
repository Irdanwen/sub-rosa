import type { RecordingSource, RecordingSourceMode } from "./tauri";

/** Whether one source can record right now (`audio/readiness.rs`). Lives
 * apart from `tauri.ts` so that file stays under its size ratchet; it is
 * re-exported there, where every caller imports it from. */
export type SourceReadinessDto = {
  source: RecordingSource;
  required: boolean;
  ready: boolean;
  permissionState: "unknown" | "granted" | "denied" | "restricted" | "unsupported";
  deviceAvailable: boolean;
  captureAvailable: boolean;
  recoveryAction?:
    | "openMicrophoneSettings"
    | "openSystemAudioSettings"
    | "upgradeMacos"
    | "restartApp"
    /** Windows: no sound output device to listen to. */
    | "checkSoundOutput";
  message?: string;
};

export type RecordingSourceReadinessDto = {
  sourceMode: RecordingSourceMode;
  ready: boolean;
  checkedAt?: string;
  sources: SourceReadinessDto[];
};
