// The retouch session on a phone: the shared workspace, full screen, pushed
// over the Studio tab. Back closes it; the versions stay in the gallery.

import { useEffect, useState } from "react";
import { t } from "../../../../lib/i18n";
import { listArtifacts } from "../../../../lib/studio/artifacts";
import { fetchMediaCatalog } from "../../../../lib/studio/catalog";
import { rootIdOf } from "../../../../lib/studio/retouch/lineage";
import { writeCursor } from "../../../../lib/studio/retouch/prefs";
import { PREFERRED_RETOUCH_MODEL } from "../../../../lib/studio/retouch/request";
import type { MediaCatalog, MediaModel } from "../../../../lib/studio/types";
import { RetouchWorkspace } from "../../../studio/retouch/RetouchWorkspace";
import { Spinner } from "../../../ui/Spinner";
import { ModelSheet } from "../../ModelSheet";
import { ModelPickerButton, modelSubtitle } from "./StudioControls";

/**
 * The retouch model on a phone: the same sheet as every other Studio picker,
 * not the desktop dialog, which opened light over a dark screen and listed
 * raw model ids.
 */
function PhoneRetouchModel({
  models,
  model,
  onModel,
}: {
  models: MediaModel[];
  model?: MediaModel;
  onModel: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ModelPickerButton
        label={t("Retouch model")}
        value={model?.name ?? ""}
        onOpen={() => setOpen(true)}
      />
      {open ? (
        <ModelSheet
          title={t("Retouch model")}
          entries={models
            .filter((entry) => !entry.offline)
            .map((entry) => ({
              id: entry.id,
              name: entry.name,
              subtitle: modelSubtitle(entry),
              tags:
                entry.id === PREFERRED_RETOUCH_MODEL ? [{ label: t("Recommended") }] : undefined,
            }))}
          selectedId={model?.id ?? ""}
          pinnedId={PREFERRED_RETOUCH_MODEL}
          onSelect={(id) => {
            if (id) onModel(id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function RetouchScreen({
  artifactId,
  rootId: knownRoot,
  onBack,
}: {
  artifactId: string;
  /** Known when a notification names the session: the version it opens on may
   * not be filed yet, and the session shows it the moment it is. */
  rootId?: string;
  onBack: () => void;
}) {
  const [catalog, setCatalog] = useState<MediaCatalog | null>(null);
  const [rootId, setRootId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchMediaCatalog()
      .then((value) => {
        if (!cancelled) setCatalog(value);
      })
      .catch(() => {
        if (!cancelled) setError(t("The model catalog is unavailable."));
      });
    if (knownRoot) {
      writeCursor(knownRoot, artifactId);
      setRootId(knownRoot);
    } else {
      // Open on the image that was picked: a version continues its session.
      listArtifacts("image")
        .then((images) => {
          if (cancelled) return;
          const picked = images.find((image) => image.id === artifactId);
          const root = picked ? rootIdOf(picked) : artifactId;
          writeCursor(root, artifactId);
          setRootId(root);
        })
        .catch(() => {
          if (!cancelled) setRootId(artifactId);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [artifactId, knownRoot]);

  return (
    <div className="mobile-retouch-screen">
      {error ? (
        <div className="retouch-gone">
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={onBack}>
            {t("Close")}
          </button>
        </div>
      ) : catalog && rootId ? (
        <RetouchWorkspace
          catalog={catalog}
          rootId={rootId}
          layout="phone"
          onClose={onBack}
          renderModelControl={(control) => <PhoneRetouchModel {...control} />}
        />
      ) : (
        <div className="mobile-retouch-loading">
          <Spinner aria-label={t("Loading")} />
        </div>
      )}
    </div>
  );
}
