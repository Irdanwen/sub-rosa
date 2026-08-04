// Pick an image out of the gallery to fill an input slot.
//
// This inverts how the gallery reached the rest of the Studio. The existing
// affordance is a push: the gallery card carries a "Send to edit" button that
// knows its one destination and hardcodes it (`setMode("edit")`). That cannot
// serve a second slot without a second button, and it asks the user to go find
// the picture first and think about where it should land second.
//
// A pull reads the other way round: the slot being filled opens the gallery and
// takes what it needs, so every image input gets the affordance for free and
// none of them appears on the gallery card. Mobile already works this way (the
// reference picker's "From gallery" sheet); this is that idea on desktop.

import { useCallback, useEffect, useState } from "react";
import { artifactDataUrl } from "../../lib/artifact-media";
import { artifactSrc, listArtifacts } from "../../lib/studio/artifacts";
import type { StudioArtifact } from "../../lib/studio/types";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";

export function GalleryPicker({
  onPick,
  onClose,
  title = "From the gallery",
  description = "Pick an image you have already produced.",
}: {
  /** The picked image as a data URI, plus the artifact it came from. */
  onPick: (dataUri: string, artifact: StudioArtifact) => void;
  onClose: () => void;
  title?: string;
  description?: string;
}) {
  const [artifacts, setArtifacts] = useState<StudioArtifact[] | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    listArtifacts("image")
      .then((entries) => {
        if (!cancelled) setArtifacts(entries);
      })
      .catch(() => {
        if (!cancelled) setArtifacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = useCallback(
    async (artifact: StudioArtifact) => {
      setBusyId(artifact.id);
      setError(undefined);
      try {
        // Read through the media loader rather than building the data URI by
        // hand: it derives the mime from the file rather than assuming PNG,
        // which a jpeg or webp source would otherwise be mislabelled as.
        onPick(await artifactDataUrl(artifact), artifact);
        onClose();
      } catch {
        setError("Couldn't read that image from the gallery.");
      } finally {
        setBusyId(undefined);
      }
    },
    [onPick, onClose],
  );

  return (
    <Dialog open onClose={onClose} title={title} description={description} width={640}>
      <div className="dialog-body">
        {artifacts === undefined ? (
          <div className="studio-picker-empty">
            <Spinner aria-label="Loading the gallery" />
          </div>
        ) : artifacts.length === 0 ? (
          <p className="studio-picker-empty">
            Nothing here yet. Images you generate, edit, or capture from a clip land in the gallery.
          </p>
        ) : (
          <div className="studio-picker-grid">
            {artifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                className="studio-picker-cell"
                disabled={busyId !== undefined}
                title={artifact.prompt || artifact.fileName}
                onClick={() => void pick(artifact)}
              >
                <img src={artifactSrc(artifact)} alt={artifact.prompt || "Gallery image"} />
                {busyId === artifact.id ? (
                  <span className="studio-picker-busy">
                    <Spinner aria-label="Loading" />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
        {error ? <p className="studio-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}
