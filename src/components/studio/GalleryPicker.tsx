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

import { useCallback, useEffect, useMemo, useState } from "react";
import { artifactDataUrl } from "../../lib/artifact-media";
import {
  type BibleEntry,
  BIBLE_KIND_LABELS,
  BIBLE_ROLE_LABELS,
  listBibleEntries,
} from "../../lib/studio/bible";
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
  offerBible = true,
}: {
  /**
   * The picked item as a data URI (empty when `resolveData` is off), plus the
   * artifact it came from - and, when it was picked out of the bible, the
   * entry it belongs to. That third argument is what lets a slot carry a
   * character's invariant traits along with their face, which is the whole
   * reason for having named them.
   */
  onPick: (dataUri: string, artifact: StudioArtifact, entry?: BibleEntry) => void;
  onClose: () => void;
  title?: string;
  description?: string;
  /** Which gallery buckets to offer. Defaults to images. */
  kinds?: ArtifactKind[];
  /** Read the item's bytes into a data URI on pick. Callers that only need
   * the artifact reference (the workflow asset node) turn this off — reading
   * a whole clip for its id would be waste. */
  resolveData?: boolean;
  /** Offer the bible above the raw gallery. On by default: a slot filled from
   * a named character is the whole point of having named one. */
  offerBible?: boolean;
}) {
  const [artifacts, setArtifacts] = useState<StudioArtifact[] | undefined>(undefined);
  const [bible, setBible] = useState<BibleEntry[]>([]);
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

  useEffect(() => {
    if (!offerBible) return;
    let cancelled = false;
    listBibleEntries()
      .then((entries) => {
        if (!cancelled) setBible(entries);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [offerBible]);

  /**
   * The bible, reduced to what this slot can actually take.
   *
   * A reference is a pointer, and the gallery is reconciled against the disk,
   * so an entry can legitimately have references to files that are no longer
   * there. Those are simply not offered - the Bible tab is where a broken
   * reference gets reported and dealt with, not a picker in the middle of
   * somebody's shot.
   */
  const bibleSections = useMemo(() => {
    if (artifacts === undefined) return [];
    const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    return bible
      .map((entry) => ({
        entry,
        items: entry.refs
          .map((reference) => ({ reference, artifact: byId.get(reference.artifactId) }))
          .filter(
            (item): item is { reference: (typeof entry.refs)[number]; artifact: StudioArtifact } =>
              item.artifact !== undefined,
          ),
      }))
      .filter((section) => section.items.length > 0);
  }, [bible, artifacts]);

  const pick = useCallback(
    async (artifact: StudioArtifact, entry?: BibleEntry) => {
      setBusyId(artifact.id);
      setError(undefined);
      try {
        // Read through the media loader rather than building the data URI by
        // hand: it derives the mime from the file rather than assuming PNG,
        // which a jpeg or webp source would otherwise be mislabelled as.
        onPick(resolveData ? await artifactDataUrl(artifact) : "", artifact, entry);
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
          <>
            {bibleSections.map((section) => (
              <div key={section.entry.id} className="studio-picker-section">
                <p className="studio-picker-section-title">
                  {section.entry.name}
                  <span> {BIBLE_KIND_LABELS[section.entry.kind]?.toLowerCase()}</span>
                </p>
                <div className="studio-picker-grid">
                  {section.items.map(({ reference, artifact }) => (
                    <button
                      key={reference.id}
                      type="button"
                      className="studio-picker-cell"
                      disabled={busyId !== undefined}
                      aria-label={`${section.entry.name}, ${BIBLE_ROLE_LABELS[
                        reference.role
                      ].toLowerCase()}`}
                      onClick={() => void pick(artifact, section.entry)}
                    >
                      <PickerTile artifact={artifact} />
                      <span className="studio-picker-role">
                        {BIBLE_ROLE_LABELS[reference.role]}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {bibleSections.length > 0 ? (
              <p className="studio-picker-section-title">Everything else</p>
            ) : null}
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
          </>
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
