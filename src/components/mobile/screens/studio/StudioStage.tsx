// The scene: what a Studio panel last made, at the top of the panel, in the
// result's own shape - and the veil over it while the next one is made. One
// component for the image, video and audio panels, so a wait looks like a
// wait wherever it is met (CONTEXT.md, "Stage", "Veil").

import type { ReactNode } from "react";
import { t } from "../../../../lib/i18n";
import { StageFrame, useDecodeGate } from "../../../studio/stage/StageFrame";
import type { StageWait } from "../../../studio/stage/Veil";
import { markMediaPlayback } from "./StudioControls";

export type StageResult =
  | { kind: "image"; src: string; alt?: string }
  | { kind: "video"; src: string; poster?: string }
  /** A rendered track: the frame holds its resting waveform, drawn by the caller. */
  | { kind: "audio"; src: string; wave: ReactNode };

export function StudioStage({
  aspect,
  result,
  wait,
  waitLabel,
  reveal,
  onRevealEnd,
  empty,
}: {
  /** The shape the next result will have: "16:9", "1:1", 1.5. */
  aspect?: string | number;
  /** The last thing made here, if anything. */
  result?: StageResult;
  /** The render in progress, if one is. */
  wait?: StageWait;
  /** What the veil calls the processing phase ("Rendering", "Composing"). */
  waitLabel?: string;
  /** True from the moment a result lands until its wipe has played. */
  reveal?: boolean;
  onRevealEnd?: () => void;
  /** What the empty frame says, when nothing has been made here yet. */
  empty?: ReactNode;
}) {
  const { dataReveal, onLoad } = useDecodeGate(result?.src, Boolean(reveal));
  return (
    <section className="mobile-studio-scene" aria-label={t("Latest result")}>
      <StageFrame
        aspect={aspect}
        wait={wait}
        waitLabel={waitLabel}
        empty={empty ?? t("Nothing rendered yet. The result appears here.")}
      >
        {result?.kind === "image" ? (
          <img
            key={result.src}
            className="mobile-studio-scene-picture stage-reveal"
            data-reveal={dataReveal}
            src={result.src}
            alt={result.alt ?? t("Generated image")}
            draggable={false}
            onLoad={onLoad}
            onAnimationEnd={onRevealEnd}
          />
        ) : result?.kind === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: a generated clip has no captions to offer.
          <video
            key={result.src}
            className="mobile-studio-scene-picture stage-reveal"
            data-reveal={dataReveal}
            src={result.src}
            poster={result.poster}
            playsInline
            controls
            preload="metadata"
            onLoadedData={onLoad}
            onAnimationEnd={onRevealEnd}
            onPlay={() => markMediaPlayback(true)}
            onPause={() => markMediaPlayback(false)}
            onEnded={() => markMediaPlayback(false)}
          />
        ) : result?.kind === "audio" ? (
          <div
            key={result.src}
            className="mobile-studio-scene-track stage-reveal"
            data-reveal={reveal ? "true" : undefined}
            onAnimationEnd={onRevealEnd}
          >
            {result.wave}
            {/* biome-ignore lint/a11y/useMediaCaption: a generated track has no captions to offer. */}
            <audio
              className="mobile-studio-scene-audio"
              src={result.src}
              controls
              preload="metadata"
              onPlay={() => markMediaPlayback(true)}
              onPause={() => markMediaPlayback(false)}
              onEnded={() => markMediaPlayback(false)}
            />
          </div>
        ) : undefined}
      </StageFrame>
    </section>
  );
}
