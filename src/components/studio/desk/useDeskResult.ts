// What a desk keeps about its scene: the last thing made here and whether its
// wipe has played, and the wait of a queued render read as a veil.

import { useCallback, useRef, useState } from "react";
import type { StageResult } from "../stage/Scene";
import type { StageWait } from "../stage/Veil";

export function useDeskResult() {
  const [result, setResult] = useState<StageResult | undefined>(undefined);
  const [reveal, setReveal] = useState(false);
  /** A result landed: put it on the scene, and let it wipe in. */
  const land = useCallback((next: StageResult) => {
    setResult(next);
    setReveal(true);
  }, []);
  const endReveal = useCallback(() => setReveal(false), []);
  return { result, reveal, land, endReveal, setResult };
}

type JobPhase = { phase: "queueing" } | { phase: "queued" | "processing"; startedAt: number };

/**
 * A queued render's state, as the veil wants it. A job that has reached the
 * backend carries its own start; one still on its way gets the moment it was
 * first seen, kept across ticks so the clock does not restart.
 */
export function useJobWait(
  key: string,
  state: JobPhase | undefined,
  estimateMs: number | undefined,
  label?: string,
): StageWait | undefined {
  const firstSeen = useRef<{ key: string; at: number } | undefined>(undefined);
  if (!state) {
    firstSeen.current = undefined;
    return undefined;
  }
  if (firstSeen.current?.key !== key) firstSeen.current = { key, at: Date.now() };
  return {
    seed: key,
    phase: state.phase,
    startedAt: state.phase === "queueing" ? firstSeen.current.at : state.startedAt,
    estimateMs,
    label: state.phase === "processing" ? label : undefined,
  };
}
