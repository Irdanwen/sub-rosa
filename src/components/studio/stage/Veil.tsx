// The veil: the darkroom's light laid over the picture a render is being
// made from, with the phase in words and the clock. It sits inside the frame
// it covers, so the wait has the result's own shape and place.
//
// Lifted out of the retouch canvas, where it was born, so every Studio
// surface waits the same way.

import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { t } from "../../../lib/i18n";
import { formatElapsed } from "../../../lib/studio/async-job";
import { darkroomSeed, darkroomVars } from "../../../lib/studio/darkroom";
import { describeRemaining, waitProgress } from "../../../lib/studio/render-eta";

export interface StageWait {
  /** Anything stable about the request; the light is derived from it. */
  seed: string;
  phase: "queueing" | "queued" | "processing";
  /** When the wait started, for the clock. */
  startedAt: number;
  /** Learned estimate for this kind of render, when there is one. */
  estimateMs?: number;
  /** Replaces the processing phase word ("Retouching", "Composing your track"). */
  label?: string;
}

/** How often the clock is redrawn. Whole seconds are shown. */
const TICK_MS = 250;

export function Veil({ wait, defaultLabel }: { wait: StageWait; defaultLabel?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const light = useMemo(() => darkroomVars(darkroomSeed(wait.seed)), [wait.seed]);
  const elapsed = Math.max(0, now - wait.startedAt);
  // A queued render is not being worked on yet: no estimate, no bar position.
  const timed = wait.phase === "processing";
  const progress = timed ? waitProgress(elapsed, wait.estimateMs) : undefined;
  const remaining = timed ? describeRemaining(elapsed, wait.estimateMs) : undefined;
  const phase =
    wait.phase === "queueing"
      ? t("Submitting")
      : wait.phase === "queued"
        ? t("Queued, waiting for a slot")
        : (wait.label ?? defaultLabel ?? t("Rendering"));
  return (
    <div className="stage-veil" style={light as CSSProperties} data-phase={wait.phase}>
      <div className="darkroom-field" aria-hidden>
        <span className="darkroom-lights">
          <span className="darkroom-light darkroom-light-a" />
          <span className="darkroom-light darkroom-light-b" />
          <span className="darkroom-light darkroom-light-c" />
        </span>
        <span className="darkroom-grain" />
      </div>
      <div className="stage-veil-caption">
        <span aria-live="polite">{phase}</span>
        <span className="stage-veil-clock">
          {formatElapsed(elapsed)}
          {remaining ? ` · ${remaining}` : ""}
        </span>
      </div>
      <div
        className="darkroom-bar"
        data-indeterminate={progress === undefined ? "true" : undefined}
      >
        <span style={progress === undefined ? undefined : { transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}
