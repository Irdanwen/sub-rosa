// Where a retouch starts on a phone: the photos already on it. The library and
// the camera come first, the Studio's own pictures after, and the sessions in
// progress last, so a picture taken a minute ago is one tap from a retouch.

import { IconCamera1 } from "central-icons/IconCamera1";
import { IconImages1 } from "central-icons/IconImages1";
import { IconSparkle } from "central-icons/IconSparkle";
import { useMemo, useRef, useState } from "react";
import { friendlyErrorMessage } from "../../../../lib/errors";
import { hapticImpact } from "../../../../lib/haptics";
import { t } from "../../../../lib/i18n";
import { requestCompose } from "../../../../lib/studio/compose/jobs";
import { requestRetouch } from "../../../../lib/studio/retouch/jobs";
import { sessionsIn } from "../../../../lib/studio/retouch/lineage";
import type { StudioArtifact } from "../../../../lib/studio/types";
import { importImageFile } from "../../../studio/retouch/RetouchPicker";
import { Spinner } from "../../../ui/Spinner";
import { GalleryCell } from "./StudioLibrary";

const RECENT = 6;

export function RetouchLauncher({
  galleryImages,
  purpose = "retouch",
}: {
  galleryImages: StudioArtifact[];
  /** Where a picked photo goes: a retouch session, or the composer. */
  purpose?: "retouch" | "compose";
}) {
  const start = purpose === "compose" ? requestCompose : requestRetouch;
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);
  const sessions = useMemo(() => sessionsIn(galleryImages).slice(0, RECENT), [galleryImages]);
  const originals = useMemo(() => galleryImages.filter((image) => !image.edit), [galleryImages]);

  const open = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setImporting(true);
    setError(undefined);
    try {
      const artifact = await importImageFile(file);
      hapticImpact("light");
      start(artifact.id);
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("The image could not be imported.")));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mobile-retouch-launcher">
      <div className="mobile-retouch-hero">
        <IconSparkle size={22} aria-hidden />
        <div>
          {purpose === "compose" ? (
            <>
              <h3>{t("Compose from a photo")}</h3>
              <p>
                {t("Pick a photo, then a pack: new angles, scenes or formats of the same subject.")}
              </p>
            </>
          ) : (
            <>
              <h3>{t("Retouch a photo")}</h3>
              <p>
                {t("Pick a photo, then say what should change. Each retouch becomes a version.")}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="mobile-retouch-sources">
        <button
          type="button"
          className="mobile-retouch-source"
          disabled={importing}
          onClick={() => libraryRef.current?.click()}
        >
          {importing ? <Spinner /> : <IconImages1 size={22} aria-hidden />}
          <span>{t("Photo library")}</span>
        </button>
        <button
          type="button"
          className="mobile-retouch-source"
          disabled={importing}
          onClick={() => cameraRef.current?.click()}
        >
          <IconCamera1 size={22} aria-hidden />
          <span>{t("Camera")}</span>
        </button>
        <button
          type="button"
          className="mobile-retouch-source"
          aria-expanded={browsing}
          disabled={originals.length === 0}
          onClick={() => setBrowsing((open) => !open)}
        >
          <IconSparkle size={22} aria-hidden />
          <span>{t("From Studio")}</span>
        </button>
      </div>
      <input
        ref={libraryRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const { files } = event.currentTarget;
          void open(files).finally(() => {
            event.target.value = "";
          });
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          const { files } = event.currentTarget;
          void open(files).finally(() => {
            event.target.value = "";
          });
        }}
      />
      {error ? (
        <p className="mobile-dictation-error" role="alert">
          {error}
        </p>
      ) : null}
      {browsing ? (
        <section className="mobile-library-day">
          <h3 className="mobile-library-day-title">{t("From Studio")}</h3>
          <div className="mobile-studio-grid mobile-library-grid">
            {originals.slice(0, 24).map((image) => (
              <GalleryCell key={image.id} artifact={image} onOpen={() => start(image.id)} />
            ))}
          </div>
        </section>
      ) : null}
      {purpose === "retouch" && sessions.length > 0 ? (
        <section className="mobile-library-day">
          <h3 className="mobile-library-day-title">{t("Pick up a retouch")}</h3>
          <div className="mobile-studio-grid mobile-library-grid">
            {sessions.map((session) => (
              <GalleryCell
                key={session.rootId}
                artifact={session.latest}
                onOpen={() => requestRetouch(session.latest.id)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
