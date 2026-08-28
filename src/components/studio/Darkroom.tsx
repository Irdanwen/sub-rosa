import { type CSSProperties, type ReactNode, useMemo } from "react";
import { formatElapsed } from "../../lib/studio/async-job";
import {
  darkroomAspect,
  darkroomRatio,
  darkroomSeed,
  darkroomVars,
  darkroomWave,
} from "../../lib/studio/darkroom";
import { describeRemaining, waitProgress } from "../../lib/studio/render-eta";

/**
 * The frame a generation occupies while it is being made - see
 * `lib/studio/darkroom.ts` for what it is and why it shows light rather than
 * a preview.
 *
 * Two things make it worth a component rather than a spinner. It reserves the
 * result's own shape, at the result's own place in the layout, so the clip
 * arriving is a crossfade and not a jolt. And it says where the wait is: the
 * phase in words, the clock, and a bar that is either an estimate learned on
 * this machine or honestly indeterminate.
 *
 * Every studio surface shares it - the desktop queue, the mobile panels, a
 * running workflow node, a film being made - so a wait looks like a wait
 * wherever it is met.
 */
export interface DarkroomProps {
  /** Anything stable about the request; the light is derived from it. */
  seed: string;
  phase: "queueing" | "queued" | "processing";
  /** How long the wait has been going. Omitted where nothing is timing it (a
   * workflow node), and the clock is left off rather than started at zero. */
  elapsedMs?: number;
  /** Learned estimate for this kind of render, when there is one. */
  estimateMs?: number;
  /** Real progress, when the caller has some (a film knows its step count).
   * It wins over the estimate, which is only ever a guess. */
  progress?: number;
  /** The result's shape: "16:9", "1/1", 1.78. Ignored by the audio variant. */
  aspectRatio?: string | number;
  variant?: "video" | "audio";
  /** Replaces the phase word, for surfaces that name their own work
   * ("Composing your track"). */
  label?: string;
  /** Model, length, prompt - whatever names this render, under the frame. */
  meta?: ReactNode;
  /** Stop waiting, and anything else the wait can act on. */
  actions?: ReactNode;
  /** Short frame for narrow surfaces: a phone panel, a workflow node. */
  compact?: boolean;
  className?: string;
}

const PHASE_LABEL: Record<DarkroomProps["phase"], string> = {
  queueing: "Submitting",
  queued: "Queued, waiting for a slot",
  processing: "Rendering",
};

export function Darkroom({
  seed,
  phase,
  elapsedMs,
  estimateMs,
  progress,
  aspectRatio,
  variant = "video",
  label,
  meta,
  actions,
  compact,
  className,
}: DarkroomProps) {
  const light = useMemo(() => darkroomVars(darkroomSeed(seed)), [seed]);
  const wave = useMemo(
    () => (variant === "audio" ? darkroomWave(seed, compact ? 32 : 52) : undefined),
    [seed, variant, compact],
  );
  // A queued render is not being worked on yet, so it gets no estimate and no
  // bar position: pretending to know how far along it is would be inventing
  // both the start and the pace.
  const timed = phase === "processing" && elapsedMs !== undefined;
  const estimated = timed ? waitProgress(elapsedMs ?? 0, estimateMs) : undefined;
  const filled = progress ?? estimated;
  const remaining = timed ? describeRemaining(elapsedMs ?? 0, estimateMs) : undefined;
  const showClock = elapsedMs !== undefined && (phase === "queued" || phase === "processing");

  const style = {
    ...light,
    "--darkroom-aspect": darkroomAspect(aspectRatio),
    "--darkroom-ratio": `${darkroomRatio(aspectRatio)}`,
  } as CSSProperties;

  return (
    <figure
      className={["darkroom", className].filter(Boolean).join(" ")}
      data-variant={variant}
      data-phase={phase}
      data-compact={compact ? "true" : undefined}
      style={style}
    >
      <div className="darkroom-frame">
        {/* The light field is decoration: the caption below carries every word
         * an assistive reader needs. */}
        <div className="darkroom-field" aria-hidden>
          {/* The lights are tilted as a set, so the field has an axis. Anything
           * with a right way up - the waveform, the grain - stays outside it. */}
          <span className="darkroom-lights">
            <span className="darkroom-light darkroom-light-a" />
            <span className="darkroom-light darkroom-light-b" />
            <span className="darkroom-light darkroom-light-c" />
          </span>
          {wave ? (
            <span className="darkroom-wave">
              {wave.map((height, index) => (
                <span
                  // Bar positions are the identity here; the heights are a
                  // seeded silhouette and can repeat.
                  // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                  key={index}
                  style={{ "--darkroom-bar": `${height}`, "--i": `${index}` } as CSSProperties}
                />
              ))}
            </span>
          ) : null}
          <span className="darkroom-grain" />
        </div>
        <figcaption className="darkroom-caption">
          {/* Only the phase is announced. The clock changes every second, and
           * a live region on it would talk over everything else in the app. */}
          <span className="darkroom-status" aria-live="polite">
            {label ?? PHASE_LABEL[phase]}
          </span>
          {showClock ? (
            <span className="darkroom-clock">
              {formatElapsed(elapsedMs ?? 0)}
              {remaining ? ` · ${remaining}` : ""}
            </span>
          ) : null}
        </figcaption>
        <div
          className="darkroom-bar"
          data-indeterminate={filled === undefined ? "true" : undefined}
        >
          <span style={filled === undefined ? undefined : { transform: `scaleX(${filled})` }} />
        </div>
      </div>
      {meta || actions ? (
        <div className="darkroom-foot">
          {meta ? <span className="darkroom-meta">{meta}</span> : <span />}
          {actions ? <span className="studio-card-actions">{actions}</span> : null}
        </div>
      ) : null}
    </figure>
  );
}
