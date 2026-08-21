import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconFolder2 } from "central-icons/IconFolder2";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useMemo, useRef, useState } from "react";
import type { FolderDto, NoteListItemDto } from "../../../lib/tauri";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
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
  onRefresh,
}: NotesScreenProps) {
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<NoteListItemDto | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const sortedNotes = useMemo(
    () =>
      [...notes]
        .filter((note) => !archiveFolderId || !note.folderIds.includes(archiveFolderId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [notes, archiveFolderId],
  );
  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sortedNotes;
    return sortedNotes.filter(
      (note) =>
        note.title.toLowerCase().includes(needle) ||
        (note.preview ?? "").toLowerCase().includes(needle),
    );
  }, [sortedNotes, query]);

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title="Notes"
        large
        trailing={
          <>
            <input
              ref={importInputRef}
              type="file"
              accept="audio/*,.m4a,.mp3,.wav,.aac,.flac,.ogg"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) onImportAudio(file);
              }}
            />
            <button
              type="button"
              className="mobile-icon-button"
              aria-label="Import audio"
              onClick={() => importInputRef.current?.click()}
            >
              <IconArrowInbox size={20} />
            </button>
            <button
              type="button"
              className="mobile-icon-button"
              aria-label="New note"
              onClick={onCreateNote}
            >
              <IconPlusMedium size={20} />
            </button>
          </>
        }
      />
      <div className="mobile-search">
        <IconMagnifyingGlass size={16} aria-hidden />
        <input
          type="search"
          placeholder="Search notes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      {folders.length > 0 ? (
        <div className="mobile-folder-strip" role="list" aria-label="Folders">
          {folders.map((folder) => (
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
        </div>
      ) : null}
      <PullToRefresh className="mobile-list-scroll" onRefresh={onRefresh}>
        {visibleNotes.length === 0 ? (
          <EmptyState
            icon={query ? <IconMagnifyingGlass size={28} /> : <IconMicrophone size={28} />}
            title={query ? "No matches" : "No notes yet"}
            description={
              query
                ? "Try a different search."
                : "Tap the record button to capture your first meeting."
            }
          />
        ) : (
          <ul className="mobile-note-list">
            {visibleNotes.map((note) => (
              <li key={note.id}>
                <SwipeableRow
                  actions={[
                    { label: "Archive", tone: "neutral", onAction: () => onArchiveNote(note.id) },
                    {
                      label: "Delete",
                      tone: "destructive",
                      onAction: () => setConfirmDelete(note),
                    },
                  ]}
                >
                  <NoteRow
                    note={note}
                    recording={note.id === activeRecordingNoteId}
                    onSelect={() => onSelectNote(note.id)}
                  />
                </SwipeableRow>
              </li>
            ))}
          </ul>
        )}
      </PullToRefresh>
      <button type="button" className="mobile-record-fab" onClick={onRecord}>
        <IconMicrophone size={22} aria-hidden />
        <span>Record</span>
      </button>
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this note?"
        description="The note, its audio, and its transcript are removed from this device."
        confirmLabel="Delete"
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
