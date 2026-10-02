// Where a retouch starts: a session to pick up again, an image from the
// gallery, or a file from the computer (which joins the gallery first, since
// every version is a gallery image).

import { IconImages1 } from "central-icons/IconImages1";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { useArtifactPreview } from "../../../lib/artifact-media";
import { friendlyErrorMessage } from "../../../lib/errors";
import { t } from "../../../lib/i18n";
import { listArtifacts, saveArtifactFromBase64 } from "../../../lib/studio/artifacts";
import { versionTitle } from "../../../lib/studio/retouch/labels";
import { sessionsIn } from "../../../lib/studio/retouch/lineage";
import type { StudioArtifact } from "../../../lib/studio/types";
import { Spinner } from "../../ui/Spinner";

const RECENT_IMAGES = 24;
const RECENT_SESSIONS = 6;

/** Read a dropped or picked file into the gallery. */
export async function importImageFile(file: File): Promise<StudioArtifact> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(t("The file could not be read.")));
    reader.readAsDataURL(file);
  });
  const extension =
    file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png";
  return saveArtifactFromBase64(dataUrl.replace(/^data:[^,]*,/, ""), extension, {
    kind: "image",
    model: "",
    prompt: "",
  });
}

export function imageFilesOf(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((file) => /^image\/(png|jpeg|webp)$/.test(file.type));
}

export function RetouchPicker({ onOpen }: { onOpen: (artifact: StudioArtifact) => void }) {
  const [images, setImages] = useState<StudioArtifact[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void listArtifacts("image")
      .then((entries) => {
        if (!cancelled) setImages(entries);
      })
      .catch(() => {
        if (!cancelled) setImages([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessions = useMemo(() => sessionsIn(images ?? []).slice(0, RECENT_SESSIONS), [images]);
  const recent = useMemo(
    () => (images ?? []).filter((image) => !image.edit).slice(0, RECENT_IMAGES),
    [images],
  );

  const importFiles = async (files: File[]) => {
    const [file] = files;
    if (!file) return;
    setImporting(true);
    setError(undefined);
    try {
      onOpen(await importImageFile(file));
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("The image could not be imported.")));
    } finally {
      setImporting(false);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void importFiles(imageFilesOf(event.dataTransfer.files));
  };

  return (
    <div className="retouch-picker">
      <section
        className="retouch-drop"
        aria-label={t("Import an image")}
        data-dragging={dragging ? "true" : undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <h2>{t("Retouch an image")}</h2>
        <p>
          {t(
            "Pick an image, then say what should change. Each retouch becomes a version you can go back to.",
          )}
        </p>
        <div className="retouch-drop-actions">
          <button
            type="button"
            className="studio-primary-button"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            {importing ? (
              <Spinner aria-label={t("Importing")} />
            ) : (
              <IconPlusMedium size={16} aria-hidden />
            )}
            {t("Import an image")}
          </button>
          <span className="retouch-drop-hint">{t("or drop it here")}</span>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            const files = imageFilesOf(event.currentTarget.files);
            event.currentTarget.value = "";
            void importFiles(files);
          }}
        />
        {error ? (
          <p className="studio-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      {sessions.length > 0 ? (
        <section className="retouch-picker-section">
          <h3>{t("Pick up where you left off")}</h3>
          <div className="retouch-picker-grid">
            {sessions.map((session) => (
              <Tile
                key={session.rootId}
                artifact={session.latest}
                label={
                  session.versionCount === 1
                    ? t("1 version")
                    : t("{count} versions", { count: session.versionCount })
                }
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ) : null}
      <section className="retouch-picker-section">
        <h3>
          <IconImages1 size={16} aria-hidden />
          {t("From the gallery")}
        </h3>
        {images === undefined ? (
          <Spinner aria-label={t("Loading the gallery")} />
        ) : recent.length === 0 ? (
          <p className="retouch-picker-empty">
            {t("Your generated and imported images will appear here.")}
          </p>
        ) : (
          <div className="retouch-picker-grid">
            {recent.map((image) => (
              <Tile key={image.id} artifact={image} onOpen={onOpen} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({
  artifact,
  label,
  onOpen,
}: {
  artifact: StudioArtifact;
  label?: string;
  onOpen: (artifact: StudioArtifact) => void;
}) {
  const preview = useArtifactPreview(artifact);
  const name = artifact.title?.trim() || artifact.prompt.trim() || versionTitle(artifact);
  return (
    <button
      type="button"
      className="retouch-tile"
      title={name}
      aria-label={t("Retouch {name}", { name })}
      onClick={() => onOpen(artifact)}
    >
      {preview ? <img src={preview} alt="" draggable={false} /> : <span />}
      {label ? <span className="retouch-tile-label">{label}</span> : null}
    </button>
  );
}
