// The frame on the stage: the result's own shape, in the result's own place,
// holding what was last made there and the veil while the next one is made.

import { type CSSProperties, type ReactNode, useCallback, useState } from "react";
import { darkroomAspect, darkroomRatio } from "../../../lib/studio/darkroom";
import { type StageWait, Veil } from "./Veil";

export function StageFrame({
  aspect,
  wait,
  waitLabel,
  empty,
  children,
  className,
}: {
  /** The result's shape: "16:9", "1/1", 1.78. */
  aspect?: string | number;
  /** The render in progress, if one is; the veil covers the frame. */
  wait?: StageWait;
  /** What the veil calls the processing phase on this surface. */
  waitLabel?: string;
  /** Shown when nothing has been made here yet. */
  empty?: ReactNode;
  /** The media last made here: an image, a video, a waveform. */
  children?: ReactNode;
  className?: string;
}) {
  const style = {
    "--stage-aspect": darkroomAspect(aspect),
    "--stage-ratio": `${darkroomRatio(aspect)}`,
  } as CSSProperties;
  return (
    <figure className={["stage-frame", className].filter(Boolean).join(" ")} style={style}>
      {children ?? (empty ? <figcaption className="stage-frame-empty">{empty}</figcaption> : null)}
      {wait ? <Veil wait={wait} defaultLabel={waitLabel} /> : null}
    </figure>
  );
}

/**
 * The reveal gate: a result wipes in only once it is decoded, never over a
 * blank. Put the returned attribute on the media element with the class
 * `stage-reveal`, and call `onLoad` from its load event.
 */
export function useDecodeGate(
  src: string | undefined,
  reveal: boolean,
): { dataReveal: "true" | "waiting" | undefined; onLoad: () => void } {
  const [decoded, setDecoded] = useState<string | undefined>(undefined);
  const onLoad = useCallback(() => setDecoded(src), [src]);
  const wiping = reveal && decoded === src;
  return { dataReveal: reveal ? (wiping ? "true" : "waiting") : undefined, onLoad };
}
