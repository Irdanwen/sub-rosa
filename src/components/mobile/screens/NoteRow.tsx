import { intlLocale } from "../../../lib/i18n";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { useLongPress } from "../../../lib/long-press";
import { IconNoteText } from "central-icons/IconNoteText";
import type { NoteListItemDto } from "../../../lib/tauri";

type NoteRowProps = {
  note: NoteListItemDto;
  recording?: boolean;
  onSelect: () => void;
  /** Opens the row's actions. Absent where the row is not actionable. */
  onLongPress?: () => void;
};

export function NoteRow({ note, recording, onSelect, onLongPress }: NoteRowProps) {
  const longPress = useLongPress(() => onLongPress?.());
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
  // A note that came from audio and one that was typed are different things to
  // scan for; the row carried the same glyph for both, and never showed the
  // duration it already knows.
  const recorded = typeof note.durationMs === "number" && note.durationMs > 0;
  const duration = recorded ? formatDuration(note.durationMs as number) : null;

  return (
    <button
      type="button"
      className="mobile-note-row"
      // The browser synthesises a click after a long press; without this the
      // sheet opens and the note opens behind it.
      onClick={() => {
        if (longPress.consumed()) return;
        onSelect();
      }}
      {...(onLongPress ? longPress.handlers : {})}
    >
      <span className="mobile-note-row-icon" aria-hidden>
        {recorded ? <IconMicrophone size={16} /> : <IconNoteText size={16} />}
      </span>
      <span className="mobile-note-row-body">
        <span className="mobile-note-row-title">{title}</span>
        <span className="mobile-note-row-subtitle">
          {recording ? <span className="note-recording-dot" aria-hidden /> : null}
          {duration ? <span className="mobile-note-row-duration">{duration}</span> : null}
          <span data-shimmer={processing ? "true" : undefined}>{preview}</span>
        </span>
      </span>
      <span className="mobile-note-row-time">{formatNoteTime(note.updatedAt)}</span>
    </button>
  );
}

/** Recording length, as the list would say it out loud: "8 min", "1 h 04". */
function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${minutes.toString().padStart(2, "0")}`;
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
    return date.toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(intlLocale(), {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}
