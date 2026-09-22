import { t } from "../../../lib/i18n";
import { IconSparkle3 } from "central-icons/IconSparkle3";
import { IMPORTABLE_MEDIA_ACCEPT } from "../../../lib/import-media";
import { ImportLinkBar } from "../../notes-list/ImportLinkBar";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconCheckCircle2 } from "central-icons/IconCheckCircle2";
import { IconFolder2 } from "central-icons/IconFolder2";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconPlusSmall } from "central-icons/IconPlusSmall";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FolderDto, NoteListItemDto } from "../../../lib/tauri";
import { searchEverything } from "../../../lib/tauri";
import { AskNotesPanel, looksLikeAQuestion } from "../../ask/AskNotesPanel";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ActionSheet } from "../ActionSheet";
import { FolderPickerSheet } from "../FolderPickerSheet";
import { ImportSheet } from "../ImportSheet";
import { NameSheet } from "../NameSheet";
import { EmptyState } from "../../ui/EmptyState";
import { PullToRefresh } from "../PullToRefresh";
import { StackHeader } from "../StackHeader";
import { SwipeableRow } from "../SwipeableRow";
import { NoteRow } from "./NoteRow";

type NotesScreenProps = {
  notes: NoteListItemDto[];
  folders: FolderDto[];
  activeRecordingNoteId?: string;
  /** Notes assigned to this folder are hidden from the main list. */
  archiveFolderId?: string;
  onSelectNote: (noteId: string) => void;
  onRecord: () => void;
  onCreateNote: () => void;
  onImportAudio: (file: File) => void;
  onOpenFolder: (folderId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onArchiveNote: (noteId: string) => void;
  /** File notes in one folder, or in none (`undefined`). */
  onMoveNotes: (noteIds: string[], folderId: string | undefined) => void;
  onCreateFolder: (name: string) => Promise<FolderDto | undefined>;
  onRefresh: () => Promise<unknown>;
};

export function NotesScreen({
  notes,
  folders,
  activeRecordingNoteId,
  archiveFolderId,
  onSelectNote,
  onRecord,
  onCreateNote,
  onImportAudio,
  onOpenFolder,
  onDeleteNote,
  onArchiveNote,
  onMoveNotes,
  onCreateFolder,
  onRefresh,
}: NotesScreenProps) {
  const [query, setQuery] = useState("");
  // Selection: several notes moved, archived or deleted at once. The swipe and
  // the long press act on one note; filing a morning's worth needed this.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** The notes a folder picker is open for, or null. */
  const [moving, setMoving] = useState<string[] | null>(null);
  const [confirmDeleteMany, setConfirmDeleteMany] = useState(false);
  const [naming, setNaming] = useState(false);
  const [importing, setImporting] = useState(false);
  const [askQuestion, setAskQuestion] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<NoteListItemDto | null>(null);
  // The note a long press opened the actions for. The swipe still works; this
  // is the route that does not have to be discovered.
  const [rowMenu, setRowMenu] = useState<NoteListItemDto | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const sortedNotes = useMemo(
    () =>
      [...notes]
        .filter((note) => !archiveFolderId || !note.folderIds.includes(archiveFolderId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [notes, archiveFolderId],
  );
  // Ids of the notes whose body or transcript contains the query, from the
  // full-text index (migration 020). The title-and-preview filter below is
  // instant and stays first; these arrive a beat later and add the notes
  // whose match sits deeper than the preview.
  const [deepHitIds, setDeepHitIds] = useState<string[]>([]);
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setDeepHitIds([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchEverything(trimmed, 30)
        .then((hits) => {
          if (cancelled) return;
          setDeepHitIds(
            hits
              .filter((hit) => hit.kind === "note" || hit.kind === "transcript")
              .map((hit) => hit.targetId),
          );
        })
        .catch(() => {
          if (!cancelled) setDeepHitIds([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sortedNotes;
    const shallow = sortedNotes.filter(
      (note) =>
        note.title.toLowerCase().includes(needle) ||
        (note.preview ?? "").toLowerCase().includes(needle),
    );
    if (deepHitIds.length === 0) return shallow;
    const shown = new Set(shallow.map((note) => note.id));
    const byId = new Map(sortedNotes.map((note) => [note.id, note]));
    const deep = deepHitIds
      .filter((id) => !shown.has(id))
      .map((id) => byId.get(id))
      .filter((note): note is NoteListItemDto => Boolean(note));
    return [...shallow, ...deep];
  }, [sortedNotes, query, deepHitIds]);

  // The Archive is a state, not a place to file a note: it is not offered as
  // a destination, and its chip comes last.
  const destinations = folders.filter((folder) => folder.id !== archiveFolderId);
  const chips = [...destinations, ...folders.filter((folder) => folder.id === archiveFolderId)];
  // Ticked in the picker: the one folder every moved note shares, `null` when
  // none of them is filed, nothing when they come from different places.
  const movingCurrent = (() => {
    if (!moving) return undefined;
    const ids = new Set(
      notes
        .filter((note) => moving.includes(note.id))
        .map((note) => note.folderIds.find((id) => id !== archiveFolderId) ?? null),
    );
    return ids.size === 1 ? [...ids][0] : undefined;
  })();

  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const toggleSelected = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={t("Notes")}
        large
        trailing={
          <>
            <input
              ref={importInputRef}
              type="file"
              // Video too: a video file is an audio track the app reads.
              // The extension list is shared so it cannot drift from the one
              // the Rust boundary accepts.
              accept={`audio/*,video/*,${IMPORTABLE_MEDIA_ACCEPT}`}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) onImportAudio(file);
              }}
            />
            {selecting ? (
              <button type="button" className="mobile-chip-button" onClick={exitSelection}>
                {t("Done")}
              </button>
            ) : (
              <>
                {/* A file or a link: one button, one sheet. The link field
                    used to take a row of the list for good. */}
                <button
                  type="button"
                  className="mobile-icon-button"
                  aria-label={t("Import")}
                  aria-haspopup="dialog"
                  onClick={() => setImporting(true)}
                >
                  <IconArrowInbox size={20} />
                </button>
                <button
                  type="button"
                  className="mobile-icon-button"
                  aria-label={t("Select notes")}
                  onClick={() => setSelecting(true)}
                >
                  <IconCheckCircle2 size={20} />
                </button>
                <button
                  type="button"
                  className="mobile-icon-button"
                  aria-label={t("New note")}
                  onClick={onCreateNote}
                >
                  <IconPlusMedium size={20} />
                </button>
              </>
            )}
          </>
        }
      />
      <div className="mobile-search">
        <IconMagnifyingGlass size={16} aria-hidden />
        <input
          type="search"
          placeholder={t("Search notes")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      {looksLikeAQuestion(query) && askQuestion !== query.trim() ? (
        <button
          type="button"
          className="mobile-ask-button"
          onClick={() => setAskQuestion(query.trim())}
        >
          <IconSparkle3 size={14} aria-hidden />
          <span>{t("Ask your notes")}</span>
        </button>
      ) : null}
      {askQuestion ? (
        <div className="mobile-ask">
          <AskNotesPanel
            question={askQuestion}
            onOpenNote={(noteId) => {
              setAskQuestion(null);
              onSelectNote(noteId);
            }}
            onClose={() => setAskQuestion(null)}
          />
        </div>
      ) : null}
      <div className="mobile-folder-strip" aria-label={t("Folders")}>
        {chips.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className="mobile-folder-chip"
            onClick={() => onOpenFolder(folder.id)}
          >
            <IconFolder2 size={14} aria-hidden />
            <span>{folder.name}</span>
          </button>
        ))}
        <button
          type="button"
          className="mobile-folder-chip mobile-folder-chip-new"
          aria-haspopup="dialog"
          onClick={() => setNaming(true)}
        >
          <IconPlusSmall size={14} aria-hidden />
          <span>{t("Folder")}</span>
        </button>
      </div>
      {/* Downloads under way stay in sight on the list; the field that starts
          them lives in the Import sheet (ADR-0028 rails A and B). */}
      <div className="mobile-link-import">
        <ImportLinkBar showField={false} onCompleted={() => void onRefresh()} />
      </div>
      <PullToRefresh className="mobile-list-scroll" onRefresh={onRefresh}>
        {visibleNotes.length === 0 ? (
          <EmptyState
            icon={query ? <IconMagnifyingGlass size={28} /> : <IconMicrophone size={28} />}
            title={query ? t("No matches") : t("No notes yet")}
            description={
              query
                ? t("Try a different search.")
                : t("Tap the record button to capture your first meeting.")
            }
          />
        ) : (
          <ul className="mobile-note-list">
            {visibleNotes.map((note) => (
              <li key={note.id}>
                {selecting ? (
                  <NoteRow
                    note={note}
                    recording={note.id === activeRecordingNoteId}
                    selecting
                    selected={selected.has(note.id)}
                    onSelect={() => toggleSelected(note.id)}
                  />
                ) : (
                  <SwipeableRow
                    actions={[
                      {
                        label: t("Archive"),
                        tone: "neutral",
                        onAction: () => onArchiveNote(note.id),
                      },
                      {
                        label: t("Delete"),
                        tone: "destructive",
                        onAction: () => setConfirmDelete(note),
                      },
                    ]}
                  >
                    <NoteRow
                      note={note}
                      recording={note.id === activeRecordingNoteId}
                      onSelect={() => onSelectNote(note.id)}
                      onLongPress={() => setRowMenu(note)}
                    />
                  </SwipeableRow>
                )}
              </li>
            ))}
          </ul>
        )}
      </PullToRefresh>
      {selecting ? (
        <div className="mobile-selection-bar">
          <span className="mobile-selection-count">
            {t("{count} selected", { count: selected.size })}
          </span>
          <button
            type="button"
            className="mobile-chip-button"
            disabled={selected.size === 0}
            onClick={() => setMoving([...selected])}
          >
            {t("Move")}
          </button>
          <button
            type="button"
            className="mobile-chip-button"
            disabled={selected.size === 0}
            onClick={() => {
              for (const id of selected) onArchiveNote(id);
              exitSelection();
            }}
          >
            {t("Archive notes")}
          </button>
          <button
            type="button"
            className="mobile-chip-button mobile-chip-destructive"
            disabled={selected.size === 0}
            onClick={() => setConfirmDeleteMany(true)}
          >
            {t("Delete")}
          </button>
        </div>
      ) : (
        <button type="button" className="mobile-record-fab" onClick={onRecord}>
          <IconMicrophone size={22} aria-hidden />
          <span>{t("Record")}</span>
        </button>
      )}
      {rowMenu ? (
        <ActionSheet
          title={rowMenu.title.trim() || t("New note")}
          subtitle={t("What would you like to do with this note?")}
          actions={[
            { label: t("Open"), onAction: () => onSelectNote(rowMenu.id) },
            { label: t("Move to a folder"), onAction: () => setMoving([rowMenu.id]) },
            { label: t("Archive"), onAction: () => onArchiveNote(rowMenu.id) },
            {
              label: t("Delete"),
              destructive: true,
              onAction: () => setConfirmDelete(rowMenu),
            },
          ]}
          onClose={() => setRowMenu(null)}
        />
      ) : null}
      {moving ? (
        <FolderPickerSheet
          title={
            moving.length === 1
              ? t("Move to a folder")
              : t("Move {count} notes", { count: moving.length })
          }
          folders={destinations}
          currentFolderId={movingCurrent}
          onPick={(folderId) => {
            onMoveNotes(moving, folderId);
            setMoving(null);
            exitSelection();
          }}
          onCreate={(name) => {
            const ids = moving;
            setMoving(null);
            exitSelection();
            void onCreateFolder(name).then((folder) => {
              if (folder) onMoveNotes(ids, folder.id);
            });
          }}
          onClose={() => setMoving(null)}
        />
      ) : null}
      {naming ? (
        <NameSheet
          title={t("New folder")}
          label={t("Folder name")}
          confirmLabel={t("Create")}
          onSubmit={(name) => {
            setNaming(false);
            void onCreateFolder(name);
          }}
          onClose={() => setNaming(false)}
        />
      ) : null}
      {importing ? (
        <ImportSheet
          onChooseFile={() => {
            setImporting(false);
            importInputRef.current?.click();
          }}
          onCompleted={() => void onRefresh()}
          onClose={() => setImporting(false)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDeleteMany}
        title={t("Delete {count} notes?", { count: selected.size })}
        description={t(
          "The notes, their audio, and their transcripts are removed from this device.",
        )}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={() => {
          for (const id of selected) onDeleteNote(id);
          setConfirmDeleteMany(false);
          exitSelection();
        }}
        onClose={() => setConfirmDeleteMany(false)}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("Delete this note?")}
        description={t("The note, its audio, and its transcript are removed from this device.")}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={() => {
          if (confirmDelete) onDeleteNote(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
