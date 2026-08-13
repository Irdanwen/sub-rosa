// Pick an item out of the gallery to fill an input slot.
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
import type { ArtifactKind, StudioArtifact } from "../../lib/studio/types";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";

const DEFAULT_KINDS: ArtifactKind[] = ["image"];

export function GalleryPicker({
  onPick,
  onClose,
  title = "From the gallery",
  description = "Pick an image you have already produced.",
  kinds = DEFAULT_KINDS,
  resolveData = true,
}: {
  /** The picked item as a data URI (empty when `resolveData` is off), plus
   * the artifact it came from. */
  onPick: (dataUri: string, artifact: StudioArtifact) => void;
  onClose: () => void;
  title?: string;
  description?: string;
  /** Which gallery buckets to offer. Defaults to images. */
  kinds?: ArtifactKind[];
  /** Read the item's bytes into a data URI on pick. Callers that only need
   * the artifact reference (the workflow asset node) turn this off — reading
   * a whole clip for its id would be waste. */
  resolveData?: boolean;
}) {
  const [artifacts, setArtifacts] = useState<StudioArtifact[] | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // A value-stable key: callers pass fresh array literals on every render.
  const kindsKey = kinds.join(",");

  useEffect(() => {
    let cancelled = false;
    const wanted = new Set(kindsKey.split(","));
    listArtifacts()
      .then((entries) => {
        if (!cancelled) setArtifacts(entries.filter((entry) => wanted.has(entry.kind)));
      })
      .catch(() => {
        if (!cancelled) setArtifacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kindsKey]);

  const pick = useCallback(
    async (artifact: StudioArtifact) => {
      setBusyId(artifact.id);
      setError(undefined);
      try {
        // Read through the media loader rather than building the data URI by
        // hand: it derives the mime from the file rather than assuming PNG,
        // which a jpeg or webp source would otherwise be mislabelled as.
        onPick(resolveData ? await artifactDataUrl(artifact) : "", artifact);
        onClose();
      } catch {
        setError("Couldn't read that item from the gallery.");
      } finally {
        setBusyId(undefined);
      }
    },
    [onPick, onClose, resolveData],
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
            Nothing here yet. Media you generate, edit, or capture lands in the gallery.
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
                <PickerTile artifact={artifact} />
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

function PickerTile({ artifact }: { artifact: StudioArtifact }) {
  if (artifact.kind === "video") {
    return (
      // biome-ignore lint/a11y/useMediaCaption: generated clips have no track
      <video src={artifactSrc(artifact)} muted playsInline preload="metadata" />
    );
  }
  if (artifact.kind === "image") {
    return <img src={artifactSrc(artifact)} alt={artifact.prompt || "Gallery image"} />;
  }
  return (
    <span className="studio-picker-file">
      <span className="studio-picker-file-kind">{artifact.kind}</span>
      <span className="studio-picker-file-name">{artifact.prompt || artifact.fileName}</span>
    </span>
  );
}
