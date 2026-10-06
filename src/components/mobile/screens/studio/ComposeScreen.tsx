// The composer on a phone: the shared workspace, pushed over the Studio tab.
// Back closes it; the images keep rendering and land in their gallery folder.

import { useEffect, useState } from "react";
import { t } from "../../../../lib/i18n";
import { deleteArtifact, listArtifacts } from "../../../../lib/studio/artifacts";
import { fetchMediaCatalog } from "../../../../lib/studio/catalog";
import type { MediaCatalog, StudioArtifact } from "../../../../lib/studio/types";
import { ComposeWorkspace } from "../../../studio/compose/ComposeWorkspace";
import { Spinner } from "../../../ui/Spinner";
import { StackHeader } from "../../StackHeader";
import { StudioViewer } from "./StudioViewer";

export function ComposeScreen({ artifactId, onBack }: { artifactId: string; onBack: () => void }) {
  const [catalog, setCatalog] = useState<MediaCatalog | null>(null);
  const [source, setSource] = useState<StudioArtifact>();
  const [error, setError] = useState<string>();
  const [viewing, setViewing] = useState<{ items: StudioArtifact[]; index: number }>();

  useEffect(() => {
    let cancelled = false;
    fetchMediaCatalog()
      .then((value) => {
        if (!cancelled) setCatalog(value);
      })
      .catch(() => {
        if (!cancelled) setError(t("The model catalog is unavailable."));
      });
    listArtifacts("image")
      .then((images) => {
        if (cancelled) return;
        const picked = images.find((image) => image.id === artifactId);
        if (picked) setSource(picked);
        else setError(t("This image is no longer in the gallery."));
      })
      .catch(() => {
        if (!cancelled) setError(t("This image is no longer in the gallery."));
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  const current = viewing ? viewing.items[viewing.index] : undefined;
  return (
    <div className="mobile-screen-root">
      <StackHeader title={t("Compose")} onBack={onBack} backLabel={t("Studio")} />
      <div className="mobile-settings-scroll">
        {error ? (
          <p className="mobile-dictation-error" role="alert">
            {error}
          </p>
        ) : catalog && source ? (
          <ComposeWorkspace
            catalog={catalog}
            source={source}
            layout="phone"
            onChangeSource={onBack}
            onOpenResult={(artifact, results) =>
              setViewing({ items: results, index: Math.max(0, results.indexOf(artifact)) })
            }
          />
        ) : (
          <div className="mobile-retouch-loading">
            <Spinner aria-label={t("Loading")} />
          </div>
        )}
      </div>
      {viewing && current ? (
        <StudioViewer
          artifact={current}
          among={viewing.items}
          onNavigate={(next) =>
            setViewing({ ...viewing, index: Math.max(0, viewing.items.indexOf(next)) })
          }
          onClose={() => setViewing(undefined)}
          onDelete={() => {
            void deleteArtifact(current).finally(() => setViewing(undefined));
          }}
          onUpscaled={() => undefined}
        />
      ) : null}
    </div>
  );
}
