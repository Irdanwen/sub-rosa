// The desktop gallery: everything the Studio made, in one place, organised
// the way the phone organises it. Folders, favourites and hidden items are
// the synchronised marks of ADR-0073, so a file filed on one device is filed
// on the other; what each view shows comes from lib/studio/gallery-view.ts,
// which the phone's gallery uses too.

import { IconHeart as IconHeartFilled } from "central-icons-filled/IconHeart";
import { IconPlay } from "central-icons-filled/IconPlay";
import { IconArrowDownCircle } from "central-icons/IconArrowDownCircle";
import { IconAudio } from "central-icons/IconAudio";
import { IconChevronLeftMedium } from "central-icons/IconChevronLeftMedium";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconHeart } from "central-icons/IconHeart";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCanSimple } from "central-icons/IconTrashCanSimple";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useArtifactThumbnail } from "../../lib/artifact-media";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  artifactSrc,
  deleteArtifact,
  exportArtifact,
  listArtifacts,
} from "../../lib/studio/artifacts";
import {
  AUDIO_KINDS,
  type GalleryView,
  groupByDay,
  visibleArtifacts,
} from "../../lib/studio/gallery-view";
import { STUDIO_IMAGE_RECOVERED_EVENT } from "../../lib/studio/image-job-recovery";
import {
  canMark,
  deleteCollection,
  EMPTY_LIBRARY,
  loadLibrary,
  markArtifacts,
  markOf,
  saveCollection,
  type StudioCollection,
  type StudioLibrary,
  withMarks,
} from "../../lib/studio/library";
import type { StudioArtifact } from "../../lib/studio/types";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { MediaViewer } from "./MediaViewer";
import "./studio-gallery.css";

type Change = { favorite?: boolean; hidden?: boolean; collectionId?: string | null };

export function StudioGalleryDesktop() {
  const [items, setItems] = useState<StudioArtifact[] | null>(null);
  const [library, setLibrary] = useState<StudioLibrary>(EMPTY_LIBRARY);
  const [view, setView] = useState<GalleryView>("all");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<string>();
  const [filing, setFiling] = useState<StudioArtifact>();
  const [removing, setRemoving] = useState<StudioArtifact>();
  const [naming, setNaming] = useState<{ collection?: StudioCollection } | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<StudioCollection>();
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const [entries, marks] = await Promise.all([
      listArtifacts(),
      loadLibrary().catch(() => EMPTY_LIBRARY),
    ]);
    setItems(entries);
    setLibrary(marks);
  }, []);
  useEffect(() => {
    void reload().catch((cause) => {
      setItems([]);
      setError(messageFromError(cause));
    });
    const onRecovered = () => void reload().catch(() => undefined);
    window.addEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
    return () => window.removeEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
  }, [reload]);

  const visible = useMemo(
    () => visibleArtifacts(items ?? [], library, { view, collectionId, query }),
    [items, library, view, collectionId, query],
  );
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const openFolder = library.collections.find((folder) => folder.id === collectionId);

  // The grid answers at once; the native write catches up, and a failure puts
  // the marks back the way the store has them.
  const mark = useCallback((artifacts: StudioArtifact[], change: Change) => {
    setLibrary((current) => withMarks(current, artifacts, change));
    markArtifacts(artifacts, change).catch((cause) => {
      setError(messageFromError(cause));
      void loadLibrary()
        .then(setLibrary)
        .catch(() => undefined);
    });
  }, []);

  const remove = useCallback(
    async (artifact: StudioArtifact) => {
      await deleteArtifact(artifact);
      setOpened((current) => (current === artifact.id ? undefined : current));
      await reload();
    },
    [reload],
  );

  const choose = (next: GalleryView) => {
    setView(next);
    setCollectionId(null);
  };

  if (items === null) return <div className="studio-gallery" aria-busy="true" />;

  const actionsFor = (artifact: StudioArtifact) => {
    const current = markOf(library, artifact);
    const markable = canMark(artifact);
    return (
      <>
        {markable ? (
          <button type="button" onClick={() => mark([artifact], { favorite: !current?.favorite })}>
            {current?.favorite ? t("Remove from favorites") : t("Add to favorites")}
          </button>
        ) : null}
        {markable ? (
          <button type="button" onClick={() => setFiling(artifact)}>
            {t("Add to a folder")}
          </button>
        ) : null}
        {markable ? (
          <button type="button" onClick={() => mark([artifact], { hidden: !current?.hidden })}>
            {current?.hidden ? t("Show again") : t("Hide")}
          </button>
        ) : null}
        <button type="button" onClick={() => void exportArtifact(artifact)}>
          {t("Save a copy")}
        </button>
        <button type="button" onClick={() => setRemoving(artifact)}>
          {t("Delete")}
        </button>
      </>
    );
  };

  const counts = (folder: StudioCollection) =>
    (items ?? []).filter((item) => {
      const found = markOf(library, item);
      return found?.collectionId === folder.id && !found.hidden;
    });

  return (
    <div className="studio-gallery">
      <div className="studio-gallery-bar">
        <SegmentedControl
          value={view}
          onValueChange={choose}
          aria-label={t("Gallery view")}
          options={[
            { value: "all", label: t("All") },
            { value: "image", label: t("Images") },
            { value: "video", label: t("Videos") },
            { value: "audio", label: t("Audio") },
            { value: "favorites", label: t("Favorites") },
            { value: "collections", label: t("Folders") },
            { value: "hidden", label: t("Hidden") },
          ]}
        />
        <label className="studio-gallery-search">
          <IconMagnifyingGlass size={14} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder={t("Search the gallery")}
            aria-label={t("Search the gallery")}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>
      {error ? (
        <p className="studio-error" role="alert">
          {error}
        </p>
      ) : null}

      {view === "collections" && !collectionId ? (
        <div className="studio-gallery-folders">
          <button
            type="button"
            className="studio-gallery-folder studio-gallery-folder-new"
            onClick={() => setNaming({})}
          >
            <IconPlusMedium size={18} aria-hidden />
            <span>{t("New folder")}</span>
          </button>
          {library.collections.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              items={counts(folder)}
              onOpen={() => setCollectionId(folder.id)}
            />
          ))}
        </div>
      ) : (
        <>
          {openFolder ? (
            <div className="studio-gallery-folder-head">
              <button type="button" className="btn btn-ghost" onClick={() => setCollectionId(null)}>
                <IconChevronLeftMedium size={14} aria-hidden />
                {t("Folders")}
              </button>
              <h2>{openFolder.name}</h2>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setNaming({ collection: openFolder })}
              >
                {t("Rename folder")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDeletingFolder(openFolder)}
              >
                {t("Delete the folder")}
              </button>
            </div>
          ) : null}
          {visible.length === 0 ? (
            <EmptyState
              icon={<IconFolder1 size={28} />}
              title={
                items.length === 0
                  ? t("Nothing generated yet")
                  : query.trim()
                    ? t("Nothing matches that search.")
                    : t("Nothing here yet.")
              }
              description={
                items.length === 0
                  ? t("Images, videos and audio you make in Studio collect here, on this device.")
                  : undefined
              }
            />
          ) : (
            groups.map(([day, dayItems]) => (
              <section key={day} className="studio-gallery-day" aria-label={day}>
                <h3>{day}</h3>
                <div className="studio-gallery-grid">
                  {dayItems.map((artifact) => (
                    <GalleryCard
                      key={artifact.id}
                      artifact={artifact}
                      favorite={Boolean(markOf(library, artifact)?.favorite)}
                      markable={canMark(artifact)}
                      onOpen={() => setOpened(artifact.id)}
                      onFavorite={() =>
                        mark([artifact], { favorite: !markOf(library, artifact)?.favorite })
                      }
                      onFile={() => setFiling(artifact)}
                      onExport={() => void exportArtifact(artifact)}
                      onDelete={() => setRemoving(artifact)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}

      {opened && visible.some((artifact) => artifact.id === opened) ? (
        <MediaViewer
          items={visible.map((artifact) => ({
            artifact,
            title: artifact.title || artifact.prompt?.trim() || undefined,
          }))}
          index={visible.findIndex((artifact) => artifact.id === opened)}
          onIndex={(index) => setOpened(visible[index]?.id)}
          onClose={() => setOpened(undefined)}
          actions={actionsFor}
        />
      ) : null}

      {filing ? (
        <FileDialog
          artifact={filing}
          library={library}
          onClose={() => setFiling(undefined)}
          onFile={(target) => {
            mark([filing], { collectionId: target });
            setFiling(undefined);
          }}
          onCreate={async (name) => {
            const folder = await saveCollection(name);
            setLibrary((current) => ({
              ...current,
              collections: [...current.collections, folder],
            }));
            mark([filing], { collectionId: folder.id });
            setFiling(undefined);
          }}
        />
      ) : null}

      {naming ? (
        <NameDialog
          title={naming.collection ? t("Rename folder") : t("New folder")}
          initial={naming.collection?.name ?? ""}
          onClose={() => setNaming(null)}
          onSave={async (name) => {
            const folder = await saveCollection(name, naming.collection?.id);
            setLibrary((current) => ({
              ...current,
              collections: naming.collection
                ? current.collections.map((entry) => (entry.id === folder.id ? folder : entry))
                : [...current.collections, folder],
            }));
            setNaming(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(undefined)}
        title={t("Delete this item?")}
        description={t("They are deleted from this device and from your other synced devices.")}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          try {
            await remove(removing);
          } catch (cause) {
            setError(messageFromError(cause));
          }
          setRemoving(undefined);
        }}
      />
      <ConfirmDialog
        open={Boolean(deletingFolder)}
        onClose={() => setDeletingFolder(undefined)}
        title={t("Delete the folder")}
        description={t("Folder deleted. Its items are still in the gallery.")}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={async () => {
          if (!deletingFolder) return;
          try {
            await deleteCollection(deletingFolder.id);
            setCollectionId(null);
            setLibrary(await loadLibrary());
          } catch (cause) {
            setError(messageFromError(cause));
          }
          setDeletingFolder(undefined);
        }}
      />
    </div>
  );
}

function GalleryCard({
  artifact,
  favorite,
  markable,
  onOpen,
  onFavorite,
  onFile,
  onExport,
  onDelete,
}: {
  artifact: StudioArtifact;
  favorite: boolean;
  markable: boolean;
  onOpen: () => void;
  onFavorite: () => void;
  onFile: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const label = artifact.title || artifact.prompt?.trim() || artifact.fileName;
  return (
    <figure className="studio-gallery-card" data-kind={artifact.kind}>
      <button
        type="button"
        className="studio-gallery-open"
        aria-label={t("Open {name}", { name: label })}
        onClick={onOpen}
      >
        <CardVisual artifact={artifact} />
        {favorite ? (
          <span className="studio-gallery-favorite" aria-hidden>
            <IconHeartFilled size={13} />
          </span>
        ) : null}
      </button>
      <figcaption className="studio-card-meta">
        <span className="studio-card-prompt" title={artifact.prompt}>
          {label}
        </span>
        <span className="studio-card-actions">
          {markable ? (
            <button
              type="button"
              className="studio-icon-button"
              aria-pressed={favorite}
              aria-label={favorite ? t("Remove from favorites") : t("Add to favorites")}
              title={favorite ? t("Remove from favorites") : t("Add to favorites")}
              onClick={onFavorite}
            >
              {favorite ? <IconHeartFilled size={14} /> : <IconHeart size={14} />}
            </button>
          ) : null}
          {markable ? (
            <button
              type="button"
              className="studio-icon-button"
              aria-label={t("Add to a folder")}
              title={t("Add to a folder")}
              onClick={onFile}
            >
              <IconFolderAddRight size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="studio-icon-button"
            aria-label={t("Save a copy")}
            title={t("Save a copy")}
            onClick={onExport}
          >
            <IconArrowDownCircle size={14} />
          </button>
          <button
            type="button"
            className="studio-icon-button"
            aria-label={t("Delete")}
            title={t("Delete")}
            onClick={onDelete}
          >
            <IconTrashCanSimple size={14} />
          </button>
        </span>
      </figcaption>
    </figure>
  );
}

/** Images stream from disk on the desktop; a clip shows its poster, decoded
 * once and cached; a sound shows what it is. */
function CardVisual({ artifact }: { artifact: StudioArtifact }) {
  const audio = AUDIO_KINDS.includes(artifact.kind);
  const thumbnail = useArtifactThumbnail(artifact.kind === "video" ? artifact : null);
  if (artifact.kind === "image") {
    return <img src={artifactSrc(artifact)} alt="" loading="lazy" decoding="async" />;
  }
  if (audio) {
    return (
      <span className="studio-gallery-sound" aria-hidden>
        <IconAudio size={24} />
      </span>
    );
  }
  return (
    <>
      {thumbnail?.kind === "still" ? (
        <img src={thumbnail.src} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="studio-gallery-sound" aria-hidden />
      )}
      <span className="studio-gallery-play" aria-hidden>
        <IconPlay size={12} />
      </span>
    </>
  );
}

function FolderCard({
  folder,
  items,
  onOpen,
}: {
  folder: StudioCollection;
  items: StudioArtifact[];
  onOpen: () => void;
}) {
  const cover = items.find((item) => item.kind === "image" || item.kind === "video");
  return (
    <button type="button" className="studio-gallery-folder" onClick={onOpen}>
      <span className="studio-gallery-folder-cover">
        {cover ? <CardVisual artifact={cover} /> : <IconFolder1 size={22} aria-hidden />}
      </span>
      <span className="studio-gallery-folder-name">{folder.name}</span>
      <span className="studio-gallery-folder-count">
        {items.length === 1 ? t("1 item") : t("{count} items", { count: items.length })}
      </span>
    </button>
  );
}

function FileDialog({
  artifact,
  library,
  onClose,
  onFile,
  onCreate,
}: {
  artifact: StudioArtifact;
  library: StudioLibrary;
  onClose: () => void;
  onFile: (collectionId: string | null) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const current = markOf(library, artifact)?.collectionId ?? null;
  const [name, setName] = useState("");
  const [failure, setFailure] = useState("");
  return (
    <Dialog open onClose={onClose} title={t("Add to a folder")}>
      <div className="dialog-body studio-gallery-file">
        {library.collections.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className="studio-gallery-file-option"
            aria-pressed={folder.id === current}
            onClick={() => onFile(folder.id)}
          >
            <IconFolder1 size={14} aria-hidden />
            {folder.name}
          </button>
        ))}
        {current ? (
          <button type="button" className="studio-gallery-file-option" onClick={() => onFile(null)}>
            {t("Take out of its folder")}
          </button>
        ) : null}
        <form
          className="studio-gallery-file-new"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            void onCreate(trimmed).catch((cause) => setFailure(messageFromError(cause)));
          }}
        >
          <input
            className="studio-input"
            value={name}
            placeholder={t("Folder name")}
            aria-label={t("Folder name")}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <button type="submit" className="btn btn-secondary" disabled={!name.trim()}>
            {t("New folder")}
          </button>
        </form>
        {failure ? <p role="alert">{failure}</p> : null}
      </div>
    </Dialog>
  );
}

function NameDialog({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [failure, setFailure] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void onSave(trimmed).catch((cause) => setFailure(messageFromError(cause)));
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="studio-primary-button"
            disabled={!name.trim()}
            onClick={submit}
          >
            {initial ? t("Rename") : t("Create")}
          </button>
        </>
      }
    >
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          className="studio-input"
          value={name}
          aria-label={t("Folder name")}
          placeholder={t("Folder name")}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        {failure ? <p role="alert">{failure}</p> : null}
      </form>
    </Dialog>
  );
}
