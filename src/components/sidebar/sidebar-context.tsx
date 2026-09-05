import { intlLocale, t } from "../../lib/i18n";
import type { NoteListItemDto } from "../../lib/tauri";
import { IconUnpin } from "central-icons/IconUnpin";
import { IconPin } from "central-icons/IconPin";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconFolderDelete } from "central-icons/IconFolderDelete";

export function AgentSessionContextMenu({
  pinned,
  deleting,
  right,
  top,
  onTogglePinned,
  onDelete,
  onClose,
}: {
  pinned: boolean;
  deleting: boolean;
  right: number;
  top: number;
  onTogglePinned: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="context-menu"
      style={{ right, top }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onTogglePinned();
          onClose();
        }}
      >
        {pinned ? <IconUnpin size={14} /> : <IconPin size={14} />}
        {pinned ? t("Unpin session") : t("Pin session")}
      </button>
      <div className="context-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="destructive"
        disabled={deleting}
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <IconTrashCan size={14} />
        {t("Delete session")}
      </button>
    </div>
  );
}

// Compact trailing timestamp for agent session rows: "now", "5m", "3h", "2d"
// while recent, then "May 2". sessionTimestamp falls back to the epoch when a
// session has no dates at all, which we render as nothing rather than 1970.
export function formatSessionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return "";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return t("now");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t("{minutes}m", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{hours}h", { hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("{days}d", { days });
  return date.toLocaleDateString(intlLocale(), {
    month: "short",
    day: "numeric",
  });
}

export function NoteContextMenu({
  noteId,
  right,
  top,
  notes,
  onOpenMoveDialog,
  onRemoveNoteFromFolder,
  onDeleteNote,
  onClose,
}: {
  noteId: string;
  right: number;
  top: number;
  notes: NoteListItemDto[];
  onOpenMoveDialog: (noteId: string) => void;
  onRemoveNoteFromFolder: (noteId: string, folderId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onClose: () => void;
}) {
  const note = notes.find((item) => item.id === noteId);
  const currentFolderId = note?.folderIds[0];
  const hasFolder = Boolean(currentFolderId);

  return (
    <div
      className="context-menu"
      style={{ right, top }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onOpenMoveDialog(noteId);
          onClose();
        }}
      >
        {hasFolder ? <IconMoveFolder size={14} /> : <IconFolderAddRight size={14} />}
        {hasFolder ? t("Change project") : t("Add to project")}
      </button>
      {hasFolder && currentFolderId ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onRemoveNoteFromFolder(noteId, currentFolderId);
            onClose();
          }}
        >
          <IconFolderDelete size={14} />
          {t("Remove from project")}
        </button>
      ) : null}
      <div className="context-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="destructive"
        onClick={() => {
          onDeleteNote(noteId);
          onClose();
        }}
      >
        <IconTrashCan size={14} />
        {t("Delete note")}
      </button>
    </div>
  );
}
