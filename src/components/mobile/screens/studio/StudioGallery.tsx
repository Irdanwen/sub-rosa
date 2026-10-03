// The gallery tab: everything the Studio made, organised the way a person
// keeps photos. Kinds and favourites to narrow it, collections shown as
// folders, a long press for what can be done to one item, a drag to select
// many, a pinch to change how many fit on a row, and a hidden section kept out
// of the way. Organisation is stored natively and travels with the account
// (ADR-0073); posters and measures come filed with each item, so a tile paints
// without decoding anything.

import { IconHeart as IconHeartFilled } from "central-icons-filled/IconHeart";
import { IconPlay } from "central-icons-filled/IconPlay";
import { IconAudio } from "central-icons/IconAudio";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronLeftMedium } from "central-icons/IconChevronLeftMedium";
import { IconEyeSlash } from "central-icons/IconEyeSlash";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconHeart } from "central-icons/IconHeart";
import { IconLayoutGrid1 } from "central-icons/IconLayoutGrid1";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconShareOs } from "central-icons/IconShareOs";
import { IconSoundFx } from "central-icons/IconSoundFx";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  evictArtifactDataUrl,
  useArtifactThumbnail,
  useTrackShape,
} from "../../../../lib/artifact-media";
import { hapticNotify, hapticSelection } from "../../../../lib/haptics";
import { t } from "../../../../lib/i18n";
import { useLongPress } from "../../../../lib/long-press";
import { isMobilePlatform } from "../../../../lib/mobile";
import { deleteArtifact } from "../../../../lib/studio/artifacts";
import { darkroomSeed, darkroomWave } from "../../../../lib/studio/darkroom";
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
} from "../../../../lib/studio/library";
import { requestRetouch, shareVersionFile } from "../../../../lib/studio/retouch/jobs";
import type { ArtifactKind, StudioArtifact } from "../../../../lib/studio/types";
import { saveToPhotos } from "../../../../lib/tauri";
import { EmptyState } from "../../../ui/EmptyState";
import { Spinner } from "../../../ui/Spinner";
import { ActionSheet, type SheetAction } from "../../ActionSheet";
import { NameSheet } from "../../NameSheet";
import { OptionSheet } from "../../OptionSheet";
import { sheetHost } from "../../sheet-host";
import { formatNoteTime } from "../NoteRow";
import { dayLabel, formatClipLength } from "./StudioLibrary";

type View = "all" | "image" | "video" | "audio" | "favorites" | "collections" | "hidden";

const AUDIO_KINDS: ArtifactKind[] = ["music", "speech", "sfx"];
const COLUMNS_KEY = "subrosa:studio:gallery-columns";
const MIN_COLUMNS = 1;
const MAX_COLUMNS = 4;

function readColumns(): number {
  try {
    const value = Number(window.localStorage.getItem(COLUMNS_KEY));
    return value >= MIN_COLUMNS && value <= MAX_COLUMNS ? value : 3;
  } catch {
    return 3;
  }
}

function writeColumns(value: number): void {
  try {
    window.localStorage.setItem(COLUMNS_KEY, String(value));
  } catch {
    // A remembered density is a nicety.
  }
}

/** A sheet portaled to the shell: inside the scrolling gallery a fixed layer
 * would position against the stack's transformed ancestor. */
function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, sheetHost());
}

export function StudioGallery({
  items,
  onOpen,
  onChanged,
  onContinueShot,
  onReusePrompt,
  pending = [],
}: {
  items: StudioArtifact[];
  /** Opens one item in the viewer, with the list it was opened from (for
   * swiping to the next one). */
  onOpen: (artifact: StudioArtifact, among: StudioArtifact[]) => void;
  onChanged: () => void;
  onContinueShot?: (artifact: StudioArtifact) => void;
  onReusePrompt?: (artifact: StudioArtifact) => void;
  pending?: { key: string }[];
}) {
  const [library, setLibrary] = useState<StudioLibrary>(EMPTY_LIBRARY);
  const [view, setView] = useState<View>("all");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [columns, setColumnsState] = useState(readColumns);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [menuFor, setMenuFor] = useState<StudioArtifact | null>(null);
  const [filing, setFiling] = useState<StudioArtifact[] | null>(null);
  const [naming, setNaming] = useState<
    | { mode: "create"; files?: StudioArtifact[] }
    | { mode: "rename"; collection: StudioCollection }
    | null
  >(null);
  const [collectionMenu, setCollectionMenu] = useState<StudioCollection | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StudioArtifact[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshLibrary = useCallback(() => {
    loadLibrary()
      .then(setLibrary)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);

  const setColumns = useCallback((value: number) => {
    const next = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, value));
    setColumnsState(next);
    writeColumns(next);
  }, []);

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 1800);
  }, []);

  /** Changes marks at once on screen, then natively; a failed write reloads. */
  const applyMarks = useCallback(
    (targets: StudioArtifact[], change: Parameters<typeof markArtifacts>[1]) => {
      setLibrary((current) => withMarks(current, targets, change));
      markArtifacts(targets, change).catch(() => {
        hapticNotify("error");
        refreshLibrary();
      });
    },
    [refreshLibrary],
  );

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const hiddenCount = useMemo(
    () => items.filter((item) => markOf(library, item)?.hidden).length,
    [items, library],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      const mark = markOf(library, item);
      if (view === "hidden") {
        if (!mark?.hidden) return false;
      } else if (mark?.hidden) {
        return false;
      }
      if (view === "image" && item.kind !== "image") return false;
      if (view === "video" && item.kind !== "video") return false;
      if (view === "audio" && !AUDIO_KINDS.includes(item.kind)) return false;
      if (view === "favorites" && !mark?.favorite) return false;
      if (view === "collections" && (!collectionId || mark?.collectionId !== collectionId)) {
        return false;
      }
      if (!needle) return true;
      return [item.prompt, item.model, item.title].some((field) =>
        (field ?? "").toLowerCase().includes(needle),
      );
    });
  }, [items, library, view, collectionId, query]);

  const groups = useMemo(() => {
    const buckets = new Map<string, StudioArtifact[]>();
    for (const item of visible) {
      const label = dayLabel(item.createdAt);
      const bucket = buckets.get(label);
      if (bucket) bucket.push(item);
      else buckets.set(label, [item]);
    }
    return [...buckets.entries()];
  }, [visible]);

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.path)),
    [items, selected],
  );

  const toggle = useCallback((path: string, on?: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      const want = on ?? !next.has(path);
      if (want) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const removeItems = useCallback(
    async (targets: StudioArtifact[]) => {
      setBusy(true);
      for (const artifact of targets) {
        try {
          await deleteArtifact(artifact);
          evictArtifactDataUrl(artifact.path);
        } catch {
          // Left in place; the next listing reconciles with the disk.
        }
      }
      setBusy(false);
      hapticNotify("success");
      exitSelection();
      onChanged();
      refreshLibrary();
    },
    [exitSelection, onChanged, refreshLibrary],
  );

  // A pinch changes how many fit on a row, as in Photos. WebKit reports it as
  // a gesture with a scale; elsewhere the density button does the same.
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const onGestureStart = (event: Event) => event.preventDefault();
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      const scale = (event as Event & { scale?: number }).scale ?? 1;
      if (scale > 1.2) setColumns(columns - 1);
      else if (scale < 0.83) setColumns(columns + 1);
    };
    element.addEventListener("gesturestart", onGestureStart);
    element.addEventListener("gestureend", onGestureEnd);
    return () => {
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gestureend", onGestureEnd);
    };
  }, [columns, setColumns]);

  // In selection, a sideways drag paints the selection across tiles; a mostly
  // vertical one still scrolls.
  const drag = useRef<{ x: number; y: number; on: boolean; active: boolean } | null>(null);
  const pathAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest("[data-gallery-path]") as HTMLElement | null)?.dataset
      .galleryPath;
  const dragHandlers = selecting
    ? {
        onTouchStart: (event: React.TouchEvent) => {
          const touch = event.touches[0];
          if (!touch || event.touches.length !== 1) return;
          const path = pathAt(touch.clientX, touch.clientY);
          drag.current = {
            x: touch.clientX,
            y: touch.clientY,
            on: path ? !selected.has(path) : true,
            active: false,
          };
        },
        onTouchMove: (event: React.TouchEvent) => {
          const state = drag.current;
          const touch = event.touches[0];
          if (!state || !touch) return;
          const dx = Math.abs(touch.clientX - state.x);
          const dy = Math.abs(touch.clientY - state.y);
          if (!state.active) {
            if (dx > 12 && dx > dy) {
              state.active = true;
              const first = pathAt(state.x, state.y);
              if (first) toggle(first, state.on);
            } else if (dy > 12) {
              drag.current = null;
            }
            return;
          }
          const path = pathAt(touch.clientX, touch.clientY);
          if (path) toggle(path, state.on);
        },
        onTouchEnd: () => {
          if (drag.current?.active) hapticSelection();
          drag.current = null;
        },
      }
    : {};

  const itemActions = (artifact: StudioArtifact): SheetAction[] => {
    const mark = markOf(library, artifact);
    const markable = canMark(artifact);
    const actions: SheetAction[] = [
      { label: t("Open"), onAction: () => onOpen(artifact, visible) },
    ];
    if (markable) {
      actions.push({
        label: mark?.favorite ? t("Remove from favourites") : t("Add to favourites"),
        onAction: () => applyMarks([artifact], { favorite: !mark?.favorite }),
      });
      actions.push({ label: t("Add to a folder"), onAction: () => setFiling([artifact]) });
    }
    if (isMobilePlatform()) {
      actions.push({
        label: t("Share"),
        onAction: () => void shareVersionFile(artifact.path).catch(() => hapticNotify("error")),
      });
      if (artifact.kind === "image" || artifact.kind === "video") {
        actions.push({
          label: t("Save to Photos"),
          onAction: () =>
            void saveToPhotos(artifact.path, artifact.kind === "video" ? "video" : "image")
              .then(() => flash(t("Saved to Photos")))
              .catch(() => hapticNotify("error")),
        });
      }
    }
    if (artifact.prompt?.trim()) {
      actions.push({
        label: t("Copy prompt"),
        onAction: () =>
          void writeText(artifact.prompt)
            .then(() => flash(t("Prompt copied")))
            .catch(() => undefined),
      });
      if (artifact.kind === "image" && onReusePrompt) {
        actions.push({ label: t("Reuse the prompt"), onAction: () => onReusePrompt(artifact) });
      }
    }
    if (artifact.kind === "video" && onContinueShot) {
      actions.push({ label: t("Continue this shot"), onAction: () => onContinueShot(artifact) });
    }
    if (artifact.kind === "image") {
      actions.push({ label: t("Touch up"), onAction: () => requestRetouch(artifact.id) });
    }
    if (markable) {
      actions.push({
        label: mark?.hidden ? t("Show again") : t("Hide"),
        onAction: () => applyMarks([artifact], { hidden: !mark?.hidden }),
      });
    }
    actions.push({
      label: t("Delete"),
      destructive: true,
      onAction: () => setConfirmDelete([artifact]),
    });
    return actions;
  };

  const tabs: { id: View; label: string }[] = [
    { id: "all", label: t("All") },
    { id: "image", label: t("Images") },
    { id: "video", label: t("Videos") },
    { id: "audio", label: t("Sounds") },
    { id: "favorites", label: t("Favourites") },
    { id: "collections", label: t("Folders") },
  ];
  const openCollection = library.collections.find((entry) => entry.id === collectionId);
  const showingFolders = view === "collections" && !collectionId;

  if (items.length === 0 && pending.length === 0) {
    return (
      <EmptyState
        icon={<IconCameraSparkle size={28} />}
        title={t("Nothing generated yet")}
        description={t("Images, videos and audio you make in Studio collect here, on this device.")}
      />
    );
  }

  return (
    <div className="mobile-gallery" data-selecting={selecting ? "true" : undefined}>
      <div className="mobile-gallery-bar">
        <label className="mobile-gallery-search">
          <IconMagnifyingGlass size={16} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder={t("Search the gallery")}
            aria-label={t("Search the gallery")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="mobile-gallery-round"
          aria-label={t("Items per row, {count}", { count: columns })}
          onClick={() => {
            hapticSelection();
            setColumns(columns >= MAX_COLUMNS ? MIN_COLUMNS : columns + 1);
          }}
        >
          <IconLayoutGrid1 size={18} aria-hidden />
        </button>
        <button
          type="button"
          className="mobile-gallery-text-button"
          onClick={() => (selecting ? exitSelection() : setSelecting(true))}
        >
          {selecting ? t("Done") : t("Select")}
        </button>
      </div>
      <fieldset className="mobile-gallery-tabs" aria-label={t("Show")}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={view === tab.id}
            className="mobile-gallery-tab"
            data-active={view === tab.id ? "true" : undefined}
            onClick={() => {
              hapticSelection();
              setView(tab.id);
              setCollectionId(null);
            }}
          >
            {tab.label}
          </button>
        ))}
      </fieldset>

      {view === "hidden" || openCollection ? (
        <div className="mobile-gallery-crumb">
          <button
            type="button"
            className="mobile-gallery-back"
            onClick={() => {
              if (openCollection) setCollectionId(null);
              else setView("all");
            }}
          >
            <IconChevronLeftMedium size={18} aria-hidden />
            {openCollection ? t("Folders") : t("Gallery")}
          </button>
          <h3 className="mobile-gallery-crumb-title">
            {openCollection ? openCollection.name : t("Hidden")}
          </h3>
          {openCollection ? (
            <button
              type="button"
              className="mobile-gallery-text-button"
              onClick={() => setCollectionMenu(openCollection)}
            >
              {t("Edit")}
            </button>
          ) : (
            <span />
          )}
        </div>
      ) : null}

      {showingFolders ? (
        <div className="mobile-gallery-folders">
          <button
            type="button"
            className="mobile-gallery-folder mobile-gallery-folder-new"
            onClick={() => setNaming({ mode: "create" })}
          >
            <span className="mobile-gallery-folder-cover">
              <IconFolderAddRight size={26} aria-hidden />
            </span>
            <span className="mobile-gallery-folder-name">{t("New folder")}</span>
          </button>
          {library.collections.map((collection) => {
            const inside = items.filter(
              (item) =>
                markOf(library, item)?.collectionId === collection.id &&
                !markOf(library, item)?.hidden,
            );
            return (
              <FolderTile
                key={collection.id}
                collection={collection}
                cover={inside[0]}
                count={inside.length}
                onOpen={() => setCollectionId(collection.id)}
                onMenu={() => setCollectionMenu(collection)}
              />
            );
          })}
        </div>
      ) : (
        <div
          ref={gridRef}
          className="mobile-gallery-body"
          data-columns={columns}
          style={{ "--gallery-columns": columns } as CSSProperties}
          {...dragHandlers}
        >
          {pending.length > 0 && view === "all" && !query.trim() && !selecting ? (
            <section className="mobile-gallery-day" aria-label={t("In progress")}>
              <h3 className="mobile-gallery-day-title">{t("In progress")}</h3>
              <div className="mobile-gallery-grid">
                {pending.map((entry) => (
                  <span key={entry.key} className="mobile-gallery-tile stage-pending">
                    <span className="mobile-studio-pending-label">{t("Rendering")}</span>
                  </span>
                ))}
              </div>
            </section>
          ) : null}
          {visible.length === 0 ? (
            <p className="mobile-gallery-empty">
              {query.trim()
                ? t("Nothing matches that search.")
                : view === "favorites"
                  ? t("Press and hold an item to add it to your favourites.")
                  : openCollection
                    ? t("This folder is empty. Press and hold an item to add it here.")
                    : t("Nothing here yet.")}
            </p>
          ) : (
            groups.map(([label, group]) => (
              <section key={label} className="mobile-gallery-day">
                <h3 className="mobile-gallery-day-title">{label}</h3>
                <div className="mobile-gallery-grid">
                  {group.map((item) => (
                    <GalleryTile
                      key={item.path}
                      artifact={item}
                      feed={columns === 1}
                      favorite={Boolean(markOf(library, item)?.favorite)}
                      selecting={selecting}
                      selected={selected.has(item.path)}
                      onTap={() => (selecting ? toggle(item.path) : onOpen(item, visible))}
                      onHold={() => {
                        if (selecting) toggle(item.path);
                        else setMenuFor(item);
                      }}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
          {view !== "hidden" && hiddenCount > 0 && !selecting ? (
            <button
              type="button"
              className="mobile-gallery-hidden-entry"
              onClick={() => {
                setView("hidden");
                setCollectionId(null);
              }}
            >
              <IconEyeSlash size={16} aria-hidden />
              {hiddenCount === 1
                ? t("1 hidden item")
                : t("{count} hidden items", { count: hiddenCount })}
            </button>
          ) : null}
        </div>
      )}

      {notice ? (
        <p className="mobile-gallery-notice" role="status">
          {notice}
        </p>
      ) : null}

      {selecting ? (
        <div className="mobile-gallery-select-bar">
          <span className="mobile-gallery-select-count">
            {selected.size === 0
              ? t("Select items")
              : selected.size === 1
                ? t("1 selected")
                : t("{size} selected", { size: selected.size })}
          </span>
          <div className="mobile-gallery-select-actions">
            <SelectAction
              label={t("Add to a folder")}
              icon={<IconFolder1 size={20} aria-hidden />}
              disabled={selectedItems.length === 0}
              onAction={() => setFiling(selectedItems)}
            />
            <SelectAction
              label={t("Add to favourites")}
              icon={<IconHeart size={20} aria-hidden />}
              disabled={selectedItems.length === 0}
              onAction={() => {
                applyMarks(selectedItems, { favorite: true });
                flash(t("Added to favourites"));
                exitSelection();
              }}
            />
            <SelectAction
              label={view === "hidden" ? t("Show again") : t("Hide")}
              icon={<IconEyeSlash size={20} aria-hidden />}
              disabled={selectedItems.length === 0}
              onAction={() => {
                applyMarks(selectedItems, { hidden: view !== "hidden" });
                exitSelection();
              }}
            />
            {isMobilePlatform() && selectedItems.length === 1 ? (
              <SelectAction
                label={t("Share")}
                icon={<IconShareOs size={20} aria-hidden />}
                onAction={() =>
                  void shareVersionFile(selectedItems[0].path).catch(() => hapticNotify("error"))
                }
              />
            ) : null}
            <SelectAction
              label={t("Delete")}
              icon={busy ? <Spinner /> : <IconTrashCan size={20} aria-hidden />}
              destructive
              disabled={selectedItems.length === 0 || busy}
              onAction={() => setConfirmDelete(selectedItems)}
            />
          </div>
        </div>
      ) : null}

      {menuFor ? (
        <Portal>
          <ActionSheet
            title={menuFor.prompt?.trim().slice(0, 80) || kindName(menuFor.kind)}
            subtitle={[menuFor.model, formatNoteTime(new Date(menuFor.createdAt).toISOString())]
              .filter(Boolean)
              .join(" · ")}
            actions={itemActions(menuFor)}
            closeLabel={t("Cancel")}
            onClose={() => setMenuFor(null)}
          />
        </Portal>
      ) : null}

      {filing ? (
        <Portal>
          <OptionSheet
            title={t("Add to a folder")}
            options={[
              ...library.collections.map((collection) => ({
                value: collection.id,
                label: collection.name,
              })),
              { value: "__new", label: t("New folder") },
              ...(filing.some((item) => markOf(library, item)?.collectionId)
                ? [{ value: "__none", label: t("Take out of its folder") }]
                : []),
            ]}
            selected={filing.length === 1 ? (markOf(library, filing[0])?.collectionId ?? "") : ""}
            onSelect={(value) => {
              const targets = filing;
              setFiling(null);
              if (value === "__new") {
                setNaming({ mode: "create", files: targets });
                return;
              }
              applyMarks(targets, { collectionId: value === "__none" ? null : value });
              hapticNotify("success");
              exitSelection();
            }}
            onClose={() => setFiling(null)}
          />
        </Portal>
      ) : null}

      {naming ? (
        <NameSheet
          title={naming.mode === "create" ? t("New folder") : t("Rename folder")}
          label={t("Folder name")}
          initialValue={naming.mode === "rename" ? naming.collection.name : ""}
          confirmLabel={naming.mode === "create" ? t("Create") : t("Rename")}
          onClose={() => setNaming(null)}
          onSubmit={(name) => {
            const current = naming;
            setNaming(null);
            const write =
              current.mode === "create"
                ? saveCollection(name)
                : saveCollection(name, current.collection.id);
            write
              .then((collection) => {
                if (current.mode === "create" && current.files?.length) {
                  applyMarks(current.files, { collectionId: collection.id });
                  exitSelection();
                }
                refreshLibrary();
                hapticNotify("success");
              })
              .catch(() => hapticNotify("error"));
          }}
        />
      ) : null}

      {collectionMenu ? (
        <Portal>
          <ActionSheet
            title={collectionMenu.name}
            actions={[
              {
                label: t("Rename"),
                onAction: () => setNaming({ mode: "rename", collection: collectionMenu }),
              },
              {
                label: t("Delete the folder"),
                destructive: true,
                onAction: () => {
                  const target = collectionMenu;
                  deleteCollection(target.id)
                    .then(() => {
                      if (collectionId === target.id) setCollectionId(null);
                      refreshLibrary();
                      flash(t("Folder deleted. Its items are still in the gallery."));
                    })
                    .catch(() => hapticNotify("error"));
                },
              },
            ]}
            closeLabel={t("Cancel")}
            onClose={() => setCollectionMenu(null)}
          />
        </Portal>
      ) : null}

      {confirmDelete ? (
        <Portal>
          <ActionSheet
            title={
              confirmDelete.length === 1
                ? t("Delete this item?")
                : t("Delete {count} items?", { count: confirmDelete.length })
            }
            subtitle={t("They are deleted from this device and from your other synced devices.")}
            actions={[
              {
                label:
                  confirmDelete.length === 1
                    ? t("Delete")
                    : t("Delete ({count})", { count: confirmDelete.length }),
                destructive: true,
                onAction: () => void removeItems(confirmDelete),
              },
            ]}
            closeLabel={t("Cancel")}
            onClose={() => setConfirmDelete(null)}
          />
        </Portal>
      ) : null}
    </div>
  );
}

function kindName(kind: ArtifactKind): string {
  const names: Record<ArtifactKind, string> = {
    image: t("Image"),
    video: t("Video"),
    music: t("Music"),
    speech: t("Speech"),
    sfx: t("Effect"),
  };
  return names[kind];
}

function SelectAction({
  label,
  icon,
  onAction,
  disabled,
  destructive,
}: {
  label: string;
  icon: ReactNode;
  onAction: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      className="mobile-gallery-select-action"
      data-destructive={destructive ? "true" : undefined}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onAction}
    >
      {icon}
    </button>
  );
}

/** Starts work for a tile only once it comes near the screen: a gallery of
 * two hundred items mounts its rows, not two hundred decodes. */
function useNearScreen<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

function GalleryTile({
  artifact,
  feed,
  favorite,
  selecting,
  selected,
  onTap,
  onHold,
}: {
  artifact: StudioArtifact;
  /** One per row: the tile keeps the item's own shape and shows its prompt. */
  feed: boolean;
  favorite: boolean;
  selecting: boolean;
  selected: boolean;
  onTap: () => void;
  onHold: () => void;
}) {
  const [ref, near] = useNearScreen<HTMLButtonElement>();
  const press = useLongPress(onHold);
  const audio = AUDIO_KINDS.includes(artifact.kind);
  const thumbnail = useArtifactThumbnail(near && !audio ? artifact : null);
  const shape = useTrackShape(near && audio ? artifact : null);
  const seconds =
    (artifact.durationMs ? artifact.durationMs / 1000 : undefined) ??
    thumbnail?.durationSeconds ??
    (shape?.durationMs ? shape.durationMs / 1000 : undefined);
  const length = seconds && seconds > 0 ? formatClipLength(seconds) : "";
  const fourK = Math.max(artifact.width ?? 0, artifact.height ?? 0) >= 3800;
  const ratio =
    feed && artifact.width && artifact.height
      ? `${artifact.width} / ${artifact.height}`
      : undefined;

  return (
    <div className="mobile-gallery-item" data-feed={feed ? "true" : undefined}>
      <button
        ref={ref}
        type="button"
        className="mobile-gallery-tile"
        data-gallery-path={artifact.path}
        data-kind={audio ? "audio" : artifact.kind}
        data-selected={selected ? "true" : undefined}
        style={ratio ? ({ aspectRatio: ratio } as CSSProperties) : undefined}
        aria-label={artifact.prompt?.trim() || kindName(artifact.kind)}
        aria-description={favorite ? t("Favourite") : undefined}
        aria-pressed={selecting ? selected : undefined}
        {...press.handlers}
        onClick={() => {
          if (press.consumed()) return;
          onTap();
        }}
      >
        {audio ? (
          <AudioArt artifact={artifact} peaks={shape?.peaks} />
        ) : thumbnail?.kind === "still" ? (
          <img src={thumbnail.src} alt="" draggable={false} loading="lazy" decoding="async" />
        ) : thumbnail?.kind === "media" ? (
          <span className="mobile-gallery-tile-fallback" aria-hidden>
            <IconPlay size={18} />
          </span>
        ) : (
          <span className="mobile-gallery-tile-loading" aria-hidden />
        )}
        {artifact.kind === "video" ? (
          <span className="mobile-gallery-badge" aria-hidden>
            <IconPlay size={10} />
            {length}
          </span>
        ) : null}
        {fourK ? (
          <span className="mobile-gallery-badge mobile-gallery-badge-top" aria-hidden>
            4K
          </span>
        ) : null}
        {favorite ? (
          <span className="mobile-gallery-favorite" aria-hidden>
            <IconHeartFilled size={13} />
          </span>
        ) : null}
        {selecting ? (
          <span
            className="mobile-gallery-check"
            data-on={selected ? "true" : undefined}
            aria-hidden
          >
            {selected ? <IconCheckmark1Small size={14} /> : null}
          </span>
        ) : null}
      </button>
      {feed ? (
        <span className="mobile-gallery-caption">
          {artifact.prompt?.trim() ? (
            <span className="mobile-gallery-caption-prompt">{artifact.prompt}</span>
          ) : null}
          <span className="mobile-gallery-caption-meta">
            {[artifact.model, formatNoteTime(new Date(artifact.createdAt).toISOString())]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      ) : null}
    </div>
  );
}

/** A track drawn as what it is: its kind, its length, and the shape of its
 * sound, on a ground tinted by the file itself so no two look alike. */
function AudioArt({ artifact, peaks }: { artifact: StudioArtifact; peaks?: number[] }) {
  const seed = darkroomSeed(artifact.path);
  const bars = useMemo(
    () => (peaks && peaks.length > 0 ? peaks : darkroomWave(artifact.path, 32)),
    [peaks, artifact.path],
  );
  const Icon =
    artifact.kind === "speech" ? IconMicrophone : artifact.kind === "sfx" ? IconSoundFx : IconAudio;
  return (
    <span
      className="mobile-gallery-audio"
      style={
        {
          "--audio-hue-a": seed.hueA,
          "--audio-hue-b": seed.hueB,
        } as CSSProperties
      }
      aria-hidden
    >
      <span className="mobile-gallery-audio-kind">
        <Icon size={14} />
      </span>
      <span className="mobile-gallery-audio-wave" data-measured={peaks ? "true" : undefined}>
        {bars.map((height, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a bar's position is its identity
          <span key={index} style={{ "--bar": `${Math.max(0.06, height)}` } as CSSProperties} />
        ))}
      </span>
      {artifact.prompt?.trim() ? (
        <span className="mobile-gallery-audio-title">{artifact.prompt.trim()}</span>
      ) : null}
    </span>
  );
}

function FolderTile({
  collection,
  cover,
  count,
  onOpen,
  onMenu,
}: {
  collection: StudioCollection;
  cover?: StudioArtifact;
  count: number;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const press = useLongPress(onMenu);
  const [ref, near] = useNearScreen<HTMLButtonElement>();
  const visual = cover && (cover.kind === "image" || cover.kind === "video") ? cover : null;
  const thumbnail = useArtifactThumbnail(near ? visual : null);
  return (
    <button
      ref={ref}
      type="button"
      className="mobile-gallery-folder"
      {...press.handlers}
      onClick={() => {
        if (press.consumed()) return;
        onOpen();
      }}
    >
      <span className="mobile-gallery-folder-cover">
        {thumbnail?.kind === "still" ? (
          <img src={thumbnail.src} alt="" draggable={false} />
        ) : (
          <IconFolder1 size={26} aria-hidden />
        )}
      </span>
      <span className="mobile-gallery-folder-name">{collection.name}</span>
      <span className="mobile-gallery-folder-count">
        {count === 1 ? t("1 item") : t("{count} items", { count })}
      </span>
    </button>
  );
}
