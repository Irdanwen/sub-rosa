// The Retouch tab: the picker until an image is chosen, then its session.

import { useCallback, useEffect, useState } from "react";
import { listArtifacts } from "../../../lib/studio/artifacts";
import { rootIdOf } from "../../../lib/studio/retouch/lineage";
import { readOpenRoot, writeCursor, writeOpenRoot } from "../../../lib/studio/retouch/prefs";
import type { MediaCatalog, StudioArtifact } from "../../../lib/studio/types";
import { RetouchPicker } from "./RetouchPicker";
import { RetouchWorkspace } from "./RetouchWorkspace";

export function RetouchStudio({
  catalog,
  pendingArtifactId,
  onPendingApplied,
}: {
  catalog: MediaCatalog;
  /** An image another surface asked to retouch; consumed once. */
  pendingArtifactId?: string;
  onPendingApplied?: () => void;
}) {
  const [rootId, setRootId] = useState<string | undefined>(readOpenRoot);

  useEffect(() => writeOpenRoot(rootId), [rootId]);

  const open = useCallback((artifact: StudioArtifact) => {
    const root = rootIdOf(artifact);
    writeCursor(root, artifact.id);
    setRootId(root);
  }, []);

  useEffect(() => {
    if (!pendingArtifactId) return;
    let cancelled = false;
    void listArtifacts("image")
      .then((images) => {
        if (cancelled) return;
        const artifact = images.find((image) => image.id === pendingArtifactId);
        if (artifact) open(artifact);
      })
      .finally(() => {
        if (!cancelled) onPendingApplied?.();
      });
    return () => {
      cancelled = true;
    };
  }, [pendingArtifactId, open, onPendingApplied]);

  return rootId ? (
    <RetouchWorkspace
      key={rootId}
      catalog={catalog}
      rootId={rootId}
      layout="desktop"
      onClose={() => setRootId(undefined)}
    />
  ) : (
    <RetouchPicker onOpen={open} />
  );
}
