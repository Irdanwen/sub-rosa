import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconMicrophoneSparkle } from "central-icons/IconMicrophoneSparkle";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../../../lib/errors";
import { hapticImpact, hapticNotify } from "../../../lib/haptics";
import { ensureNotificationPermission } from "../../../lib/notifications";
import {
  type DictationHistoryItemDto,
  type DictationStyle,
  type MobileDictationResultDto,
  mobileDeleteDictationHistoryItem,
  mobileDictationCancel,
  mobileDictationStart,
  mobileDictationStatus,
  mobileDictationStop,
  mobileListDictationHistory,
} from "../../../lib/tauri";
import { EmptyState } from "../../ui/EmptyState";
import { SettingsGroup } from "../SettingsList";
import { StackHeader } from "../StackHeader";
import { SwipeableRow } from "../SwipeableRow";
import { formatNoteTime } from "./NoteRow";

type Phase = "idle" | "recording" | "processing";

/** Past this, the wait is named rather than merely counted. */
const LONG_WAIT_MS = 10_000;

/** Elapsed, in the shape a person reads at a glance rather than a duration. */
function formatSince(ms: number) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * In-app dictation: tap to record, tap to stop, get polished text to copy.
 * The desktop's global-hotkey + paste-injection flow has no iOS equivalent,
 * so the phone treats dictation as a destination screen with history.
 */
export function DictationScreen() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [peak, setPeak] = useState(0);
  const [result, setResult] = useState<MobileDictationResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<DictationHistoryItemDto[]>([]);
  // Transcription has no progress to report -- it is one round trip -- but it
  // has a duration, and a duration counting up is the difference between "it
  // is working" and "it has died". No estimate is shown: nothing here knows
  // how long this recording will take, and an invented number is worse than
  // an honest clock.
  const [processingMs, setProcessingMs] = useState(0);
  const styleRef = useRef<DictationStyle>("standard");

  const refreshHistory = useCallback(() => {
    mobileListDictationHistory()
      .then((response) => setHistory(response.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (phase !== "processing") {
      setProcessingMs(0);
      return;
    }
    const startedAt = Date.now();
    const interval = window.setInterval(() => setProcessingMs(Date.now() - startedAt), 250);
    return () => window.clearInterval(interval);
  }, [phase]);

  // Level + elapsed polling while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      mobileDictationStatus()
        .then((status) => {
          if (cancelled || !status) return;
          setElapsedMs(status.elapsedMs);
          setPeak(status.peak);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [phase]);

  const start = useCallback(async () => {
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      await mobileDictationStart();
      setElapsedMs(0);
      setPhase("recording");
      hapticImpact("medium");
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  const stop = useCallback(async () => {
    setPhase("processing");
    // The transcription can outlive this screen: if the phone is locked before
    // it lands, Rust finishes it in the background and notifies. Ask for the
    // permission here, where the wait explains the prompt.
    void ensureNotificationPermission("dictation");
    try {
      const outcome = await mobileDictationStop({ style: styleRef.current });
      setResult(outcome);
      hapticNotify("success");
      refreshHistory();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setPhase("idle");
    }
  }, [refreshHistory]);

  const cancel = useCallback(async () => {
    try {
      await mobileDictationCancel();
    } catch {
      // Cancelling a dictation that already ended is not an error worth surfacing.
    }
    setPhase("idle");
  }, []);

  const copyResult = useCallback(async (text: string) => {
    try {
      await writeText(text);
      hapticImpact("light");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  const minutes = Math.floor(elapsedMs / 60000);
  const seconds = Math.floor((elapsedMs % 60000) / 1000);

  return (
    <div className="mobile-screen-root">
      <StackHeader title="Dictation" large />
      <div className="mobile-settings-scroll">
        <div className="mobile-dictation-stage">
          {phase === "recording" ? (
            <p className="mobile-dictation-elapsed">
              {minutes}:{String(seconds).padStart(2, "0")}
            </p>
          ) : phase === "processing" ? (
            <p className="mobile-dictation-hint" aria-live="polite">
              <span>Transcribing your recording</span>
              <span className="mobile-dictation-since">{formatSince(processingMs)}</span>
            </p>
          ) : (
            <p className="mobile-dictation-hint">
              Tap the microphone, speak, then tap again to get clean text.
            </p>
          )}
          <button
            type="button"
            className="mobile-dictation-button"
            data-recording={phase === "recording" ? "true" : undefined}
            disabled={phase === "processing"}
            aria-label={phase === "recording" ? "Stop dictation" : "Start dictation"}
            onClick={() => void (phase === "recording" ? stop() : start())}
            style={
              phase === "recording"
                ? // Drives the halo ring's scale (a transform stays on the
                  // compositor; the old box-shadow spread repainted per poll).
                  ({ "--dictation-level": Math.min(1, peak * 2.5) } as React.CSSProperties)
                : undefined
            }
          >
            <IconMicrophone size={30} aria-hidden />
          </button>
          {phase === "recording" ? (
            <button type="button" className="mobile-dictation-cancel" onClick={() => void cancel()}>
              Cancel
            </button>
          ) : null}
        </div>

        {error ? <p className="mobile-dictation-error">{error}</p> : null}

        {phase === "processing" ? (
          // The result card, before it has anything in it. Three lines that
          // breathe say "text is coming here" in a way a spinner cannot.
          <section className="mobile-dictation-result" aria-hidden>
            <div className="mobile-dictation-skeleton">
              <span className="mobile-skeleton-bar" />
              <span className="mobile-skeleton-bar" />
              <span className="mobile-skeleton-bar" />
            </div>
            {processingMs > LONG_WAIT_MS ? (
              <p className="mobile-dictation-patience">A long recording takes a moment.</p>
            ) : null}
          </section>
        ) : null}

        {result ? (
          <section className="mobile-dictation-result" aria-label="Dictation result">
            <p>{result.text}</p>
            <div className="mobile-dictation-result-actions">
              <button
                type="button"
                className="mobile-chip-button"
                onClick={() => void copyResult(result.text)}
              >
                {copied ? <IconCheckmark1Small size={14} /> : <IconClipboard size={14} />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
          </section>
        ) : null}

        {history.length === 0 && !result && phase === "idle" ? (
          <EmptyState
            icon={<IconMicrophoneSparkle size={20} />}
            title="Your voice journal starts here"
            description="Speak a note, a message, a thought. What you dictate is transcribed on the spot and kept here so you can copy it again later."
            label="No dictations yet"
          />
        ) : null}

        {history.length > 0 ? (
          <SettingsGroup title="History" footer="Tap to copy, swipe to delete.">
            {history.map((item) => (
              <SwipeableRow
                key={item.id}
                actions={[
                  {
                    label: "Delete",
                    tone: "destructive",
                    onAction: () => {
                      void mobileDeleteDictationHistoryItem(item.id).then(refreshHistory);
                    },
                  },
                ]}
              >
                <button
                  type="button"
                  className="mobile-dictation-history-item"
                  onClick={() => void copyResult(item.text)}
                >
                  <span className="mobile-dictation-history-text">{item.text}</span>
                  <span className="mobile-dictation-history-time">
                    {formatNoteTime(item.createdAt)}
                  </span>
                </button>
              </SwipeableRow>
            ))}
          </SettingsGroup>
        ) : null}
      </div>
    </div>
  );
}
