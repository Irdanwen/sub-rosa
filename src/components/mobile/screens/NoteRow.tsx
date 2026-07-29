import { IconNoteText } from "central-icons/IconNoteText";
import type { NoteListItemDto } from "../../../lib/tauri";

type NoteRowProps = {
  note: NoteListItemDto;
  recording?: boolean;
  onSelect: () => void;
};

export function NoteRow({ note, recording, onSelect }: NoteRowProps) {
  const title = note.title.trim() || "New note";
  const effectiveStatus =
    note.processingStatus === "recording" && !recording ? "draft" : note.processingStatus;
  const preview = note.preview.trim() || (recording ? "Recording" : statusLabel(effectiveStatus));
  const processing =
    !note.preview.trim() &&
    (effectiveStatus === "transcribing" ||
      effectiveStatus === "generating" ||
      effectiveStatus === "validating");

  // No wrapping <li> here: callers render rows inside their own <li> (with
  // SwipeableRow between), and nested list items are invalid DOM.
  return (
    <button type="button" className="mobile-note-row" onClick={onSelect}>
      <span className="mobile-note-row-icon" aria-hidden>
        <IconNoteText size={16} />
      </span>
      <span className="mobile-note-row-body">
        <span className="mobile-note-row-title">{title}</span>
        <span className="mobile-note-row-subtitle">
          {recording ? <span className="note-recording-dot" aria-hidden /> : null}
          <span data-shimmer={processing ? "true" : undefined}>{preview}</span>
        </span>
      </span>
      <span className="mobile-note-row-time">{formatNoteTime(note.updatedAt)}</span>
    </button>
  );
}

function statusLabel(status: NoteListItemDto["processingStatus"]) {
  switch (status) {
    case "recording":
      return "Recording";
    case "validating":
      return "Validating";
    case "transcribing":
      return "Transcribing";
    case "generating":
      return "Generating";
    case "failed":
      return "Needs attention";
    case "recoverable":
      return "Recoverable";
    case "ready":
      return "Ready";
    default:
      return "Draft";
  }
}

export function formatNoteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}
