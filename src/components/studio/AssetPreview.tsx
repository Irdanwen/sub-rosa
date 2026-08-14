// The gallery item an asset node points at, shown rather than named.
//
// A node stores an `artifactId` and nothing else - on purpose: a workflow
// lives in localStorage, so a data URI in it would bloat every save, and an
// absolute path would not survive an iOS reinstall (the app's data container
// moves). So the item is resolved at render time, from the editor's one shared
// index, and previewed the way this platform can afford to.

import { useArtifactPreview } from "../../lib/artifact-media";
import type { StudioArtifact } from "../../lib/studio/types";

export function AssetPreview({
  artifact,
  /** True once the gallery listing is back, so a missing item can be reported
   * as gone rather than as still loading. */
  loaded,
  className,
}: {
  artifact: StudioArtifact | undefined;
  loaded: boolean;
  className: string;
}) {
  const src = useArtifactPreview(artifact);
  if (!artifact) {
    // Caught here, before the run: the engine refuses a missing asset too, but
    // only minutes in, after the nodes above it have been paid for.
    return loaded ? (
      <p className={`${className} ${className}-missing`}>
        This gallery item is gone. Pick another one.
      </p>
    ) : null;
  }
  if (!src) return null;
  if (artifact.kind === "video") {
    return (
      // biome-ignore lint/a11y/useMediaCaption: a gallery clip has no track
      <video className={className} src={src} muted playsInline preload="metadata" />
    );
  }
  if (artifact.kind !== "image") return null;
  return <img className={className} src={src} alt={artifact.prompt || artifact.fileName} />;
}
