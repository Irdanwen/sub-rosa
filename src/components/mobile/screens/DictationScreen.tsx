import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconClipboard } from "central-icons/IconClipboard";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../../../lib/errors";
import { hapticImpact, hapticNotify } from "../../../lib/haptics";
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
import { StackHeader } from "../StackHeader";

type Phase = "idle" | "recording" | "processing";

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
  const styleRef = useRef<DictationStyle>("standard");

  const refreshHistory = useCallback(() => {
    mobileListDictationHistory()
      .then((response) => setHistory(response.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

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
          ) : (
            <p className="mobile-dictation-hint">
              {phase === "processing"
                ? "Transcribing..."
                : "Tap the microphone, speak, then tap again to get clean text."}
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
                ? { boxShadow: `0 0 0 ${Math.min(24, 4 + peak * 60)}px var(--brand-tint)` }
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

        {history.length > 0 ? (
          <section className="mobile-settings-section">
            <h2 className="mobile-settings-section-title">History</h2>
            <ul className="mobile-dictation-history">
              {history.map((item) => (
                <li key={item.id} className="mobile-dictation-history-item">
                  <button
                    type="button"
                    className="mobile-dictation-history-text"
                    onClick={() => void copyResult(item.text)}
                  >
                    {item.text}
                  </button>
                  <button
                    type="button"
                    className="mobile-icon-button"
                    aria-label="Delete dictation"
                    onClick={() => {
                      void mobileDeleteDictationHistoryItem(item.id).then(refreshHistory);
                    }}
                  >
                    <IconTrashCan size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
