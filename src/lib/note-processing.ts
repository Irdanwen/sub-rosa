/**
 * How far a note's pipeline has got, on its way to the screen.
 *
 * The Rust side keeps this in memory for the length of one run and hands it
 * over on `NoteDto.processingProgress` (see `domain::processing_progress`);
 * there is no event, so what arrives is a sample taken by the one-second poll
 * both shells already run while a note is transcribing or generating.
 *
 * Samples can be dropped, arrive late, or arrive out of order, so nothing here
 * trusts a single one: the merge below is what makes the bar move only
 * forwards, which is the whole difference between a progress indicator and a
 * flickering number.
 */

import { invoke } from "@tauri-apps/api/core";
import { renderEtaKey } from "./studio/render-eta";

/** The sub-step a running pipeline is on. Mirrors Rust's `ProcessingPhase`. */
export type ProcessingPhase = "preparing" | "detectingTurns" | "transcribing" | "composing";

export type ProcessingProgressDto = {
  phase: ProcessingPhase;
  /** Units finished in the current phase. */
  done: number;
  /** What the phase will do in total, when that is knowable up front. `null`
   * means draw an indeterminate bar - not a bar sitting at zero. */
  total: number | null;
  /** RFC3339. When the run started, not the phase: the elapsed clock hangs off
   * this so it survives a phase change and a reloaded webview. */
  startedAt: string;
  /** RFC3339. When the current phase started. */
  phaseStartedAt: string;
};

const PHASE_RANK: Record<ProcessingPhase, number> = {
  preparing: 0,
  detectingTurns: 1,
  transcribing: 2,
  composing: 3,
};

export function processingPhaseRank(phase: ProcessingPhase): number {
  return PHASE_RANK[phase] ?? 0;
}

/**
 * Fold a freshly polled sample into what is already on screen.
 *
 * Three rules, each paying for a way the bar could otherwise lie:
 * - a sample that went missing keeps the last one, so a dropped poll does not
 *   blank a bar that is still working;
 * - a different `startedAt` is a different run, taken whole - a retry should
 *   restart the bar honestly rather than inherit the old one's count;
 * - within a run, the phase and the count only ever move forwards.
 */
export function mergeProcessingProgress(
  current: ProcessingProgressDto | undefined,
  incoming: ProcessingProgressDto | undefined,
  stillRunning: boolean,
): ProcessingProgressDto | undefined {
  if (!incoming) return stillRunning ? current : undefined;
  if (!current || current.startedAt !== incoming.startedAt) return incoming;
  if (processingPhaseRank(incoming.phase) < processingPhaseRank(current.phase)) return current;
  if (processingPhaseRank(incoming.phase) > processingPhaseRank(current.phase)) return incoming;
  return { ...incoming, done: Math.max(current.done, incoming.done) };
}

/** The fraction to fill, or `undefined` when the honest answer is "no idea". */
export function processingFraction(progress: ProcessingProgressDto): number | undefined {
  if (progress.total === null || progress.total <= 0) return undefined;
  return Math.min(1, Math.max(0, progress.done / progress.total));
}

/**
 * The bucket a run's duration is remembered under, for the learned estimate.
 *
 * `render-eta` files Studio renders by model alone and says why: clip length
 * would sharpen the median but is not on the durable job row. A recording's
 * length *is* on the note, so it can be used here - and it matters far more,
 * since a two minute memo and a two hour meeting share nothing but a code path.
 */
export function noteEtaKey(phase: ProcessingPhase, durationMs: number | undefined): string {
  return renderEtaKey(`note-${phase}`, durationBucket(durationMs));
}

function durationBucket(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return "unknown";
  const minutes = durationMs / 60_000;
  if (minutes <= 5) return "5m";
  if (minutes <= 15) return "15m";
  if (minutes <= 45) return "45m";
  if (minutes <= 120) return "2h";
  return "2h+";
}

/**
 * Stop whatever is being done to this note, and whatever was queued behind it.
 * Returns at once; the note lands in `stopped` at the pipeline's next boundary,
 * keeping everything already transcribed and paid for.
 */
export function cancelProcessing(noteId: string): Promise<void> {
  return invoke<void>("cancel_processing", { request: { noteId } });
}
