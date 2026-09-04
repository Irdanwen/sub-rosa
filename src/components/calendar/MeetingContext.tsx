import { intlLocale, t } from "../../lib/i18n";
import { IconCalendar1 } from "central-icons/IconCalendar1";
import { useState } from "react";
import { meetingSummary } from "../../lib/calendar-link";
import { type CalendarEventDto, calendarAttachNote } from "../../lib/tauri";

/**
 * The two calendar surfaces a note ever gets — and they are the only two.
 *
 * There is no calendar screen anywhere in the app: the product specs forbid
 * a calendar surface and a meeting object, and they are right to. What a note
 * gets instead is a line saying when it was scheduled and who was invited,
 * and — when two meetings overlapped — one question, asked once, because
 * guessing between them is worse than asking.
 */

/** The line a linked note carries: when it was scheduled, and who was there. */
export function MeetingBadge({
  scheduledStart,
  attendees,
}: {
  scheduledStart?: string;
  attendees?: string[];
}) {
  if (!scheduledStart) return null;
  const start = new Date(scheduledStart);
  if (Number.isNaN(start.getTime())) return null;
  const when = start.toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
  const people = attendees ?? [];
  const who =
    people.length > 0
      ? `${people.slice(0, 3).join(", ")}${people.length > 3 ? ` +${people.length - 3}` : ""}`
      : "";
  return (
    <p className="meeting-badge">
      <span className="meeting-badge-icon" aria-hidden>
        <IconCalendar1 size={13} />
      </span>
      <span>
        {when}
        {who ? <span className="meeting-badge-who"> · {who}</span> : null}
      </span>
    </p>
  );
}

/**
 * Two meetings overlapped this recording. We ask rather than guess, once,
 * and "neither" is a real answer — a note with no event behaves exactly as
 * the app has always made it.
 */
export function MeetingAmbiguityPrompt({
  noteId,
  events,
  onResolved,
}: {
  noteId: string;
  events: CalendarEventDto[];
  onResolved: (event: CalendarEventDto | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const choose = async (eventId: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      onResolved(await calendarAttachNote(noteId, eventId));
    } catch {
      // The calendar moved under us; leaving the note unlinked is correct.
      onResolved(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="meeting-prompt" aria-label={t("Which meeting is this?")}>
      <p className="meeting-prompt-question">{t("Which meeting is this?")}</p>
      <ul className="meeting-prompt-options">
        {events.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              className="meeting-prompt-option"
              disabled={busy}
              onClick={() => void choose(event.id)}
            >
              <span className="meeting-prompt-title">{event.title || "Untitled event"}</span>
              <span className="meeting-prompt-meta">{meetingSummary(event)}</span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="meeting-prompt-dismiss"
        disabled={busy}
        onClick={() => void choose(null)}
      >
        {t("Neither")}
      </button>
    </section>
  );
}
