import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconFolder2 } from "central-icons/IconFolder2";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useState } from "react";
import type { FolderDto, NoteListItemDto } from "../../../lib/tauri";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { EmptyState } from "../../ui/EmptyState";
import { StackHeader } from "../StackHeader";
import { SwipeableRow } from "../SwipeableRow";
import { NoteRow } from "./NoteRow";

type FolderScreenProps = {
  folder?: FolderDto;
  notes: NoteListItemDto[];
  activeRecordingNoteId?: string;
  /** The auto-managed Archive folder swaps "Archive" for "Restore". */
  isArchiveFolder?: boolean;
  onBack: () => void;
  onSelectNote: (noteId: string) => void;
  onCreateNote: () => void;
  onDeleteNote: (noteId: string) => void;
  onRemoveFromFolder: (noteId: string) => void;
};

/** Notes filtered to one folder, pushed from the folder strip. */
export function FolderScreen({
  folder,
  notes,
  activeRecordingNoteId,
  isArchiveFolder,
  onBack,
  onSelectNote,
  onCreateNote,
  onDeleteNote,
  onRemoveFromFolder,
}: FolderScreenProps) {
  const [confirmDelete, setConfirmDelete] = useState<NoteListItemDto | null>(null);

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={folder?.name ?? "Folder"}
        onBack={onBack}
        backLabel="Notes"
        trailing={
          <button
            type="button"
            className="mobile-icon-button"
            aria-label="New note in folder"
            onClick={onCreateNote}
          >
            <IconPlusMedium size={20} />
          </button>
        }
      />
      <div className="mobile-list-scroll">
        {notes.length === 0 ? (
          <EmptyState
            icon={isArchiveFolder ? <IconArrowInbox size={28} /> : <IconFolder2 size={28} />}
            title={isArchiveFolder ? "Nothing archived" : "No notes in this folder"}
            description={
              isArchiveFolder
                ? "Swipe a note left in the main list to archive it."
                : "New notes land here when you assign them to this folder."
            }
          />
        ) : (
          <ul className="mobile-note-list">
            {[...notes]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((note) => (
                <li key={note.id}>
                  <SwipeableRow
                    actions={[
                      {
                        label: isArchiveFolder ? "Restore" : "Remove",
                        tone: "neutral",
                        onAction: () => onRemoveFromFolder(note.id),
                      },
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
      </div>
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
