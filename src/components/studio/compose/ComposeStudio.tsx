// The Compose tab: the picker until an image is chosen, then the composer.

import { useCallback, useEffect, useState } from "react";
import { listArtifacts } from "../../../lib/studio/artifacts";
import type { MediaCatalog, StudioArtifact } from "../../../lib/studio/types";
import { MediaViewer } from "../MediaViewer";
import { RetouchPicker } from "../retouch/RetouchPicker";
import { ComposeWorkspace } from "./ComposeWorkspace";

export function ComposeStudio({
  catalog,
  pendingArtifactId,
  onPendingApplied,
}: {
  catalog: MediaCatalog;
  /** An image another surface asked to compose from; consumed once. */
  pendingArtifactId?: string;
  onPendingApplied?: () => void;
}) {
  const [source, setSource] = useState<StudioArtifact>();
  const [viewing, setViewing] = useState<{ items: StudioArtifact[]; index: number }>();

  useEffect(() => {
    if (!pendingArtifactId) return;
    let cancelled = false;
    void listArtifacts("image")
      .then((images) => {
        if (cancelled) return;
        const artifact = images.find((image) => image.id === pendingArtifactId);
        if (artifact) setSource(artifact);
      })
      .finally(() => {
        if (!cancelled) onPendingApplied?.();
      });
    return () => {
      cancelled = true;
    };
  }, [pendingArtifactId, onPendingApplied]);

  const open = useCallback((artifact: StudioArtifact, results: StudioArtifact[]) => {
    setViewing({ items: results, index: Math.max(0, results.indexOf(artifact)) });
  }, []);

  if (!source) return <RetouchPicker onOpen={setSource} purpose="compose" />;
  return (
    <>
      <ComposeWorkspace
        key={source.id}
        catalog={catalog}
        source={source}
        layout="desktop"
        onChangeSource={() => setSource(undefined)}
        onOpenResult={open}
      />
      {viewing ? (
        <MediaViewer
          items={viewing.items.map((artifact) => ({ artifact }))}
          index={viewing.index}
          onIndex={(index) => setViewing({ ...viewing, index })}
          onClose={() => setViewing(undefined)}
        />
      ) : null}
    </>
  );
}
