import { useCallback, useEffect, useState } from "react";
import { readPreferredSourceMode, writePreferredSourceMode } from "../lib/recording-source-mode";
import {
  checkRecordingSourceReadiness,
  openPrivacySettings,
  type RecordingSourceMode,
  type RecordingSourceReadinessDto,
} from "../lib/tauri";

const SYSTEM_AUDIO_PERMISSION_REFRESH_INTERVAL_MS = 1_000;
const SYSTEM_AUDIO_PERMISSION_REFRESH_TIMEOUT_MS = 120_000;

/**
 * What a note records, and whether each source can record right now.
 *
 * `sourceMode` is the person's remembered choice, never rewritten by
 * readiness: a computer that cannot be heard today does not erase the wish
 * to record calls. Each start resolves it against fresh readiness
 * (`resolveRecordingStart`).
 */
export function useRecordingSources({
  appBlocked,
  captureActive,
}: {
  appBlocked: boolean;
  captureActive: boolean;
}) {
  const [sourceMode, setSourceMode] = useState<RecordingSourceMode>(readPreferredSourceMode);
  const [sourceReadiness, setSourceReadiness] = useState<RecordingSourceReadinessDto>();
  const [checkingSourceReadiness, setCheckingSourceReadiness] = useState(false);
  const [systemAudioRefreshRequest, setSystemAudioRefreshRequest] = useState(0);
  // The note whose current take records the microphone alone although the
  // computer was asked for: the recorder says so for as long as it runs.
  const [computerFallbackNoteId, setComputerFallbackNoteId] = useState<string>();
  // `ready` only says this computer is capable of system capture; the grant
  // is the permission state, which only a probe that includes the computer
  // establishes.
  const systemSourceReadiness = sourceReadiness?.sources.find(
    (source) => source.source === "system",
  );
  const systemGranted =
    systemSourceReadiness?.ready === true && systemSourceReadiness.permissionState === "granted";

  const handleSourceModeChange = useCallback((next: RecordingSourceMode) => {
    setSourceMode(next);
    writePreferredSourceMode(next);
  }, []);

  // Explicit "Enable" action when the computer's sound is denied: keep a
  // mode that records it, open the System Settings pane, and watch for the
  // grant while macOS is in front.
  const handleEnableSystemAudio = useCallback(() => {
    if (sourceMode === "microphoneOnly") handleSourceModeChange("microphonePlusSystem");
    setSystemAudioRefreshRequest((request) => request + 1);
    void openPrivacySettings("systemAudio");
  }, [handleSourceModeChange, sourceMode]);

  // After the user opens System Settings for System Audio Recording, keep
  // checking briefly while macOS is in front. This matches Accessibility's
  // permission flow and avoids relying on a single webview focus event.
  useEffect(() => {
    if (appBlocked || captureActive || systemGranted || systemAudioRefreshRequest === 0) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    function poll() {
      if (inFlight) return;
      inFlight = true;
      void checkRecordingSourceReadiness("microphonePlusSystem")
        .then((readiness) => {
          if (!cancelled) setSourceReadiness(readiness);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }
    poll();
    const interval = window.setInterval(poll, SYSTEM_AUDIO_PERMISSION_REFRESH_INTERVAL_MS);
    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
    }, SYSTEM_AUDIO_PERMISSION_REFRESH_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [appBlocked, captureActive, systemAudioRefreshRequest, systemGranted]);

  return {
    sourceMode,
    sourceReadiness,
    setSourceReadiness,
    checkingSourceReadiness,
    setCheckingSourceReadiness,
    computerFallbackNoteId,
    setComputerFallbackNoteId,
    handleSourceModeChange,
    handleEnableSystemAudio,
  };
}
