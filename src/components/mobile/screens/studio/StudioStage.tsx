// The scene: what a Studio panel last made, at the top of the panel, in the
// result's own shape - and the veil over it while the next one is made. One
// component for the image, video and audio panels, so a wait looks like a
// wait wherever it is met (CONTEXT.md, "Stage", "Veil").

import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { t } from "../../../../lib/i18n";
import { darkroomWave } from "../../../../lib/studio/darkroom";
import { StageFrame, useDecodeGate } from "../../../studio/stage/StageFrame";
import type { StageWait } from "../../../studio/stage/Veil";
import { markMediaPlayback } from "./StudioControls";

export type StageResult =
  | { kind: "image"; src: string; alt?: string }
  /** `onError`: the element could not load its source (see `usePlayableMediaUrl`). */
  | { kind: "video"; src: string; poster?: string; onError?: () => void }
  /** A rendered track: the frame holds its resting waveform, seeded by it. */
  | { kind: "audio"; src: string; seed: string; onError?: () => void };

/** The still silhouette of a track on the scene: the darkroom's wave, at rest.
 * It breathes only while a render runs - and then it is the veil that moves. */
export function SceneWave({ seed }: { seed: string }) {
  const bars = useMemo(() => darkroomWave(seed, 36), [seed]);
  return (
    <span className="mobile-studio-scene-wave" aria-hidden>
      {bars.map((height, index) => (
        <span
          // Bar positions are the identity here; the heights are a seeded
          // silhouette and can repeat.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          key={index}
          style={{ "--scene-bar": `${height}` } as CSSProperties}
        />
      ))}
    </span>
  );
}

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
  // The result's own shape once it is known: a model that publishes no
  // ratio, or ignores the one asked, still lands at its true proportions.
  const [measured, setMeasured] = useState<{ src: string; ratio: number } | undefined>(undefined);
  const measure = (src: string, width: number, height: number) => {
    if (width > 0 && height > 0) setMeasured({ src, ratio: width / height });
  };
  const shape = result && measured?.src === result.src ? measured.ratio : aspect;
  return (
    <section className="mobile-studio-scene" aria-label={t("Latest result")}>
      <StageFrame
        aspect={shape}
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
            onLoad={(event) => {
              measure(
                result.src,
                event.currentTarget.naturalWidth,
                event.currentTarget.naturalHeight,
              );
              onLoad();
            }}
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
            onLoadedMetadata={(event) =>
              measure(result.src, event.currentTarget.videoWidth, event.currentTarget.videoHeight)
            }
            onLoadedData={onLoad}
            onError={result.onError}
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
            <SceneWave seed={result.seed} />
            {/* biome-ignore lint/a11y/useMediaCaption: a generated track has no captions to offer. */}
            <audio
              className="mobile-studio-scene-audio"
              src={result.src}
              controls
              preload="metadata"
              onError={result.onError}
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
