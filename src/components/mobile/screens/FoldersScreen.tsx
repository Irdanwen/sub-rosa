import { t } from "../../../lib/i18n";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFolder2 } from "central-icons/IconFolder2";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useState } from "react";
import type { FolderDto, NoteListItemDto } from "../../../lib/tauri";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ActionSheet } from "../ActionSheet";
import { NameSheet } from "../NameSheet";
import { NotePickerSheet } from "../NotePickerSheet";
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
  /** Notes that are not in this folder yet, for "Add notes". */
  candidates: NoteListItemDto[];
  onAddNotes: (noteIds: string[]) => void;
  onRename: (name: string) => void;
  /** Deletes the folder; its notes go with it only when asked. */
  onDeleteFolder: (deleteNotes: boolean) => void;
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
  candidates,
  onAddNotes,
  onRename,
  onDeleteFolder,
}: FolderScreenProps) {
  const [confirmDelete, setConfirmDelete] = useState<NoteListItemDto | null>(null);
  // A folder could be filled from new notes only, and never renamed or
  // removed from the phone. These are the rest of what a folder needs.
  const [menu, setMenu] = useState<"actions" | "delete" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={folder?.name ?? t("Folder")}
        onBack={onBack}
        backLabel={t("Notes")}
        trailing={
          <>
            {/* The Archive is kept by name and managed by the app: renaming
                or deleting it here would break archiving itself. */}
            {isArchiveFolder || !folder ? null : (
              <button
                type="button"
                className="mobile-icon-button"
                aria-label={t("Folder actions")}
                aria-haspopup="dialog"
                onClick={() => setMenu("actions")}
              >
                <IconDotGrid1x3Horizontal size={18} />
              </button>
            )}
            <button
              type="button"
              className="mobile-icon-button"
              aria-label={t("New note in folder")}
              onClick={onCreateNote}
            >
              <IconPlusMedium size={20} />
            </button>
          </>
        }
      />
      <div className="mobile-list-scroll">
        {notes.length === 0 ? (
          <EmptyState
            icon={isArchiveFolder ? <IconArrowInbox size={28} /> : <IconFolder2 size={28} />}
            title={isArchiveFolder ? t("Nothing archived") : t("No notes in this folder")}
            description={
              isArchiveFolder
                ? t("Swipe a note left in the main list to archive it.")
                : t("Add notes you already have, or create one here.")
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
                        label: isArchiveFolder ? t("Restore") : t("Remove"),
                        tone: "neutral",
                        onAction: () => onRemoveFromFolder(note.id),
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
                    />
                  </SwipeableRow>
                </li>
              ))}
          </ul>
        )}
      </div>
      {menu === "actions" && folder ? (
        <ActionSheet
          title={folder.name}
          actions={[
            // Each follow-up opens once this sheet has closed and handed focus
            // back, or the hand-back would pull focus out of the new sheet.
            { label: t("Rename"), onAction: () => window.setTimeout(() => setRenaming(true), 0) },
            { label: t("Add notes"), onAction: () => window.setTimeout(() => setAdding(true), 0) },
            {
              label: t("Delete folder"),
              destructive: true,
              onAction: () => window.setTimeout(() => setMenu("delete"), 0),
            },
          ]}
          onClose={() => setMenu((current) => (current === "actions" ? null : current))}
        />
      ) : null}
      {menu === "delete" && folder ? (
        <ActionSheet
          title={t("Delete {name}?", { name: folder.name })}
          subtitle={t("The folder goes. Its notes can stay in your library, or go with it.")}
          actions={[
            {
              label: t("Delete the folder, keep the notes"),
              onAction: () => onDeleteFolder(false),
            },
            {
              label: t("Delete the folder and its notes"),
              destructive: true,
              onAction: () => onDeleteFolder(true),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {renaming && folder ? (
        <NameSheet
          title={t("Rename folder")}
          label={t("Folder name")}
          initialValue={folder.name}
          confirmLabel={t("Rename")}
          onSubmit={(name) => {
            setRenaming(false);
            onRename(name);
          }}
          onClose={() => setRenaming(false)}
        />
      ) : null}
      {adding && folder ? (
        <NotePickerSheet
          title={t("Add to {name}", { name: folder.name })}
          notes={candidates}
          confirmLabel={(count) => (count === 0 ? t("Add") : t("Add ({count})", { count }))}
          onConfirm={(noteIds) => {
            setAdding(false);
            onAddNotes(noteIds);
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
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
