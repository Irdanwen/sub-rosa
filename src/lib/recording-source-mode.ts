import type { RecordingSourceMode, RecordingSourceReadinessDto, SourceReadinessDto } from "./tauri";

/**
 * What a note records: the microphone and the computer (a call), the
 * microphone alone (a meeting in the room), or the computer alone (a webinar
 * or a video, where the person is not heard and the microphone never opens).
 * The choice is the person's and it is remembered; whether the computer can
 * be heard right now is decided at each start, never by rewriting the choice.
 */
export const RECORDING_SOURCE_MODE_STORAGE_KEY = "os-june:recording-source-mode";
export const DEFAULT_RECORDING_SOURCE_MODE: RecordingSourceMode = "microphonePlusSystem";
export const RECORDING_SOURCE_MODES: readonly RecordingSourceMode[] = [
  "microphonePlusSystem",
  "microphoneOnly",
  "systemOnly",
];

export function isRecordingSourceMode(value: unknown): value is RecordingSourceMode {
  return typeof value === "string" && (RECORDING_SOURCE_MODES as string[]).includes(value);
}

export function readPreferredSourceMode(): RecordingSourceMode {
  try {
    const stored = localStorage.getItem(RECORDING_SOURCE_MODE_STORAGE_KEY);
    if (isRecordingSourceMode(stored)) return stored;
  } catch {
    // localStorage can throw in sandboxed contexts.
  }
  return DEFAULT_RECORDING_SOURCE_MODE;
}

export function writePreferredSourceMode(mode: RecordingSourceMode) {
  try {
    localStorage.setItem(RECORDING_SOURCE_MODE_STORAGE_KEY, mode);
  } catch {
    // The choice still applies for this session.
  }
}

export function sourceModeIncludesMicrophone(mode: RecordingSourceMode) {
  return mode !== "systemOnly";
}

export function sourceModeIncludesSystem(mode: RecordingSourceMode) {
  return mode !== "microphoneOnly";
}

export type RecordingStartDecision =
  /** Start in `mode`; `fellBack` when the computer was asked for and is not
   * available, so only the microphone records and the person must be told. */
  | { kind: "start"; mode: RecordingSourceMode; fellBack: boolean }
  /** Do not start: the lane this mode cannot do without is not ready. */
  | { kind: "blocked"; source: SourceReadinessDto["source"]; message?: string };

function readinessOf(
  readiness: RecordingSourceReadinessDto,
  source: SourceReadinessDto["source"],
): SourceReadinessDto | undefined {
  return readiness.sources.find((candidate) => candidate.source === source);
}

/**
 * Decide what a start actually records. Microphone and computer degrades to
 * the microphone, visibly; the computer alone never does, because opening the
 * microphone of someone who chose not to be heard is the one fallback that
 * must not happen.
 */
export function resolveRecordingStart(
  requested: RecordingSourceMode,
  readiness: RecordingSourceReadinessDto,
): RecordingStartDecision {
  const microphone = readinessOf(readiness, "microphone");
  const system = readinessOf(readiness, "system");
  if (sourceModeIncludesMicrophone(requested) && !microphone?.ready) {
    return { kind: "blocked", source: "microphone", message: microphone?.message };
  }
  if (!sourceModeIncludesSystem(requested) || system?.ready) {
    return { kind: "start", mode: requested, fellBack: false };
  }
  if (requested === "systemOnly") {
    return { kind: "blocked", source: "system", message: system?.message };
  }
  return { kind: "start", mode: "microphoneOnly", fellBack: true };
}

const COMPUTER_START_FAILURES = new Set([
  "source_not_ready",
  "system_audio_unavailable",
  "system_audio_permission_denied",
  "system_audio_capture_unavailable",
]);

/** A microphone-and-computer start that failed on the computer's side is
 * retried with the microphone alone rather than losing the meeting. */
export function shouldRetryWithMicrophone(attempted: RecordingSourceMode, errorCode: unknown) {
  return (
    attempted === "microphonePlusSystem" &&
    typeof errorCode === "string" &&
    COMPUTER_START_FAILURES.has(errorCode)
  );
}
