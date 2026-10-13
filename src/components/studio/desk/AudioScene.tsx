// The scene of an audio desk: the track made here, wide and low, or the one
// recalled from the gallery on request. Before either, the canvas is blank:
// the newest track sitting there would read as the answer to a prompt not
// written yet.

import { useState } from "react";
import { t } from "../../../lib/i18n";
import { artifactSrc } from "../../../lib/studio/artifacts";
import type { StudioArtifact } from "../../../lib/studio/types";
import { type StageResult, StageScene } from "../stage/Scene";
import type { StageWait } from "../stage/Veil";

/** The scene's shape for a track: the darkroom's own, wide and low. */
export const TRACK_ASPECT = "5:2";

export function AudioScene({
  landed,
  newest,
  wait,
  reveal,
  onRevealEnd,
  hint,
}: {
  /** The track made in this session, if any. */
  landed?: { path: string };
  /** The newest track of this kind in the gallery, offered on request. */
  newest?: StudioArtifact;
  wait?: StageWait;
  reveal?: boolean;
  onRevealEnd?: () => void;
  hint: string;
}) {
  const [recalled, setRecalled] = useState<StudioArtifact | undefined>(undefined);
  const source = landed ?? recalled;
  const result: StageResult | undefined = source
    ? { kind: "audio", src: artifactSrc(source), seed: source.path }
    : undefined;
  return (
    <StageScene
      aspect={TRACK_ASPECT}
      result={result}
      wait={wait}
      reveal={reveal}
      onRevealEnd={onRevealEnd}
      idle={{
        seed: "audio",
        hint,
        recall:
          newest && !result
            ? { label: t("Last creation"), onRecall: () => setRecalled(newest) }
            : undefined,
      }}
    />
  );
}
