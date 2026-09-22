/**
 * What the app is doing to a recording, while it does it.
 *
 * The three words this used to show ("Transcribing audio") are true for eleven
 * minutes on a long meeting, which makes them indistinguishable from a hang.
 * Everything here exists to answer one question a reader actually has: is this
 * moving? So it shows a step, a count when there is an honest one, a bar, and
 * a clock - and it never shows a number it cannot stand behind.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { DotSpinner } from "../DotSpinner";
import { t } from "../../lib/i18n";
import { EASE_OUT } from "../../lib/motion";
import {
  type ProcessingPhase,
  type ProcessingProgressDto,
  cancelProcessing,
  noteEtaKey,
  processingFraction,
} from "../../lib/note-processing";
import { estimateRenderMs, rememberRenderMs, waitProgress } from "../../lib/studio/render-eta";
import type { NoteDto } from "../../lib/tauri";

export type ProcessingStageStatus = Extract<
  NoteDto["processingStatus"],
  "validating" | "transcribing" | "generating"
>;

/**
 * The stage name, as the rolling label and the spoken status read it.
 *
 * The phase is preferred over the status because the status cannot see inside
 * itself: a note sits at `transcribing` while the app is still normalising
 * audio or running turn detection, which on a long meeting is minutes of work
 * under a word that says something else is happening.
 *
 * Kept ellipsis-free: the roll and the bar already carry the "in progress"
 * sense, so the words can stay calm.
 */
function stageMessage(
  status: ProcessingStageStatus,
  progress: ProcessingProgressDto | undefined,
): string {
  if (progress) {
    switch (progress.phase) {
      case "preparing":
        return t("Preparing the audio");
      case "detectingTurns":
        return t("Finding who spoke when");
      case "composing":
        return t("Writing your notes");
      case "transcribing":
        // "{done} of {total} parts" rather than "part {done}": with several
        // requests in flight there is no single part being worked on, and
        // naming one would be a small lie repeated every second.
        return progress.total && progress.total > 0
          ? t("Transcribing {done} of {total} parts", {
              done: progress.done,
              total: progress.total,
            })
          : t("Transcribing the recording");
    }
  }
  switch (status) {
    case "validating":
      return t("Preparing the audio");
    case "transcribing":
      return t("Transcribing the recording");
    case "generating":
      return t("Writing your notes");
  }
}

/** "1:04" / "12:07" / "1:22:40". Monospaced digits keep it from twitching. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * The words beside the clock.
 *
 * Rounded coarsely on purpose, and it stops claiming to know anything once the
 * estimate has been passed - the same discipline `render-eta` applies to its
 * own copy, said here so it can go through `t()`.
 */
function describeRemaining(elapsedMs: number, estimateMs: number | undefined): string | undefined {
  if (!estimateMs || estimateMs <= 0) return undefined;
  const left = estimateMs - elapsedMs;
  if (left <= 0) return t("Any moment now");
  if (left < 15_000) return t("Nearly there");
  if (left < 90_000) return t("About {seconds}s left", { seconds: Math.round(left / 10_000) * 10 });
  return t("About {minutes} min left", { minutes: Math.round(left / 60_000) });
}

/** A ticking clock, owned here rather than derived from the poll: a poll that
 * misses a beat would make the seconds stutter, which reads as a stall. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * File each finished phase against its bucket, so the next recording of about
 * this length has something to estimate from. A phase change is the only
 * moment its duration is known, and `phaseStartedAt` is what makes it knowable
 * at all.
 */
function useLearnedEstimate(
  progress: ProcessingProgressDto | undefined,
  durationMs: number | undefined,
): number | undefined {
  const previous = useRef<{ phase: ProcessingPhase; startedAt: string } | undefined>(undefined);
  useEffect(() => {
    if (!progress) {
      previous.current = undefined;
      return;
    }
    const last = previous.current;
    if (last && last.phase !== progress.phase) {
      const took = Date.parse(progress.phaseStartedAt) - Date.parse(last.startedAt);
      if (Number.isFinite(took)) rememberRenderMs(noteEtaKey(last.phase, durationMs), took);
    }
    previous.current = { phase: progress.phase, startedAt: progress.phaseStartedAt };
  }, [progress, durationMs]);

  if (!progress) return undefined;
  return estimateRenderMs(noteEtaKey(progress.phase, durationMs));
}

export function ProcessingProgressIndicator({
  noteId,
  status,
  progress,
  durationMs,
  queuedRecordings = 0,
  queuedTooltipId,
  className,
}: {
  /** The note to stop. Without it there is no Stop button. */
  noteId?: string;
  status: ProcessingStageStatus;
  progress?: ProcessingProgressDto;
  durationMs?: number;
  queuedRecordings?: number;
  queuedTooltipId?: string;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const now = useNow(true);
  // Which note a Stop was pressed for. Keyed by id rather than a boolean so
  // the indicator never carries "stopping" over to the next note it shows.
  const [stoppingFor, setStoppingFor] = useState<string | null>(null);
  const stopping = noteId !== undefined && stoppingFor === noteId;
  const estimateMs = useLearnedEstimate(progress, durationMs);
  const classes = ["note-processing-progress", className].filter(Boolean).join(" ");

  const startedMs = progress ? Date.parse(progress.startedAt) : Number.NaN;
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : undefined;
  const phaseStartedMs = progress ? Date.parse(progress.phaseStartedAt) : Number.NaN;
  const phaseElapsedMs = Number.isFinite(phaseStartedMs) ? Math.max(0, now - phaseStartedMs) : 0;

  // A real count beats a guess; a guess beats nothing; nothing draws a sweep
  // rather than a bar sitting at zero. (The rule `Darkroom` already follows.)
  const counted = progress ? processingFraction(progress) : undefined;
  const filled = counted ?? waitProgress(phaseElapsedMs, estimateMs);
  const remaining =
    counted === undefined ? describeRemaining(phaseElapsedMs, estimateMs) : undefined;
  // Between the press and the pipeline reaching its next boundary there can
  // be a few seconds (a request in flight is allowed to land, because it is
  // already paid for). Saying so is what stops a second press.
  const label = stopping ? t("Stopping") : stageMessage(status, progress);

  function handleStop() {
    if (!noteId || stopping) return;
    setStoppingFor(noteId);
    cancelProcessing(noteId).catch(() => {
      // The command surface refused; release the button rather than leave a
      // "Stopping" that nothing will ever finish.
      setStoppingFor(null);
    });
  }

  return (
    <div className={classes} data-status={status} data-phase={progress?.phase}>
      <div className="note-processing-line">
        <DotSpinner className="note-processing-progress-spinner" />
        {/* A departure-board roll: each stage label rises into the one-line
            window as the previous one lifts out, blurring through the hand-off
            so the change feels organic rather than a hard cut. popLayout keeps
            the entering label in flow (so the chip stays sized) while the
            leaving one is popped out to slide away. Reduced motion drops to a
            plain crossfade. */}
        <div className="note-processing-roll" role="status" aria-live="polite">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={label}
              className="note-processing-roll-item"
              initial={
                reduceMotion ? { opacity: 0 } : { y: "65%", opacity: 0, filter: "blur(5px)" }
              }
              animate={reduceMotion ? { opacity: 1 } : { y: "0%", opacity: 1, filter: "blur(0px)" }}
              exit={reduceMotion ? { opacity: 0 } : { y: "-65%", opacity: 0, filter: "blur(5px)" }}
              transition={{ duration: reduceMotion ? 0.15 : 0.5, ease: EASE_OUT }}
            >
              {label}
            </motion.span>
          </AnimatePresence>
        </div>
        {queuedRecordings > 0 && queuedTooltipId ? (
          <span className="note-generating-count" tabIndex={0} aria-describedby={queuedTooltipId}>
            +{queuedRecordings}
            <span className="note-generating-tip" id={queuedTooltipId} role="tooltip">
              {queuedRecordings > 1
                ? t("{count} more recordings queued", { count: queuedRecordings })
                : t("1 more recording queued")}
            </span>
          </span>
        ) : null}
        {/* Deliberately outside the live region: a clock that re-announced
            itself every second would make the whole badge unreadable. */}
        {elapsedMs !== undefined ? (
          <span className="note-processing-clock">
            {formatClock(elapsedMs)}
            {remaining ? ` · ${remaining}` : null}
          </span>
        ) : null}
        {noteId ? (
          <button
            type="button"
            className="btn btn-ghost note-processing-stop"
            onClick={handleStop}
            disabled={stopping}
            aria-busy={stopping || undefined}
          >
            {t("Stop")}
          </button>
        ) : null}
      </div>
      <div className="note-processing-bar" data-indeterminate={filled === undefined || undefined}>
        <span
          className="note-processing-bar-fill"
          style={filled === undefined ? undefined : { transform: `scaleX(${filled})` }}
        />
      </div>
    </div>
  );
}

/** The stage a note's status maps to, or nothing when it is not being worked on. */
export function processingStageStatus(
  status: NoteDto["processingStatus"],
): ProcessingStageStatus | null {
  switch (status) {
    case "validating":
    case "transcribing":
    case "generating":
      return status;
    default:
      return null;
  }
}
